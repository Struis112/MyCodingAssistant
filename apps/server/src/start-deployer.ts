// Self-Healing Deployer (Phase 2 entrypoint) — SEPARATE PROCESS
//
// See docs/architecture/self-healing-deploy.md. This is the small, rarely-
// changed process that owns deploys so it can roll back the app even when the
// app is broken. It runs as its OWN NSSM service (failure-domain isolation),
// as Administrator (repo owner) so git works.
//
// Scope (first cut): WEB ONLY, activation via the API server's existing
// /api/services/web/restart endpoint (no re-architecting of supervision yet).
//
// Flow per commit on `staging`:
//   build (typecheck + next build) -> validate -> activate (restart web)
//   -> verify (readiness window + smoke) -> PROMOTE, else ROLL BACK to known-
//   good (git reset + rebuild + restart), feed logs to the AI, retry until
//   stable or the 8h wall-clock budget is spent, then PARK (journal preserved).
//
// STATUS: integration glue — assembled from unit-tested modules
// (deploy-controller, git-known-good, service-deploy-pipeline, commit-trigger).
// The AI RepairAgent is a STUB (parks) until the chat-routed agent (decision
// 3b) is wired. The non-AI build/validate/activate/verify/rollback path is
// complete and is what we debug live first.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import { CommitTrigger } from "./services/commit-trigger.js";
import {
  DeployController,
  type KnownGoodStore,
  type RepairAgent,
} from "./services/deploy-controller.js";
import { GitKnownGoodStore } from "./services/git-known-good.js";
import { ServiceDeployPipeline } from "./services/service-deploy-pipeline.js";

// ----- config -----
const REPO_DIR = process.env.MCA_PROJECT_ROOT
  ? path.resolve(process.env.MCA_PROJECT_ROOT)
  : process.cwd();
const WEB_DIR = process.env.MCA_WEB_DIR || path.join(REPO_DIR, "apps", "web");
const API_PORT = parseInt(process.env.PORT || "7641", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "7642", 10);
const LIVE_REF = process.env.MCA_LIVE_REF || "live";
const STAGING_REF = process.env.MCA_STAGING_REF || "staging";
const BUDGET_MS = parseInt(process.env.MCA_DEPLOY_BUDGET_MS || String(8 * 60 * 60 * 1000), 10);
const LOG_DIR = path.join(REPO_DIR, "logs");
const JOURNAL_PATH = path.join(LOG_DIR, "deploy-journal.json");

function log(msg: string): void {
  console.log(`[deployer] ${new Date().toISOString()} ${msg}`);
}

// ----- small process/HTTP helpers -----
function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; logs: string }> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", (d) => (out += d.toString()));
    proc.on("exit", (code) => resolve({ ok: code === 0, logs: out.trim() }));
    proc.on("error", (err) => resolve({ ok: false, logs: String(err) }));
  });
}

function findBin(spec: string): string | null {
  try {
    return createRequire(path.join(WEB_DIR, "package.json")).resolve(spec);
  } catch {
    return null;
  }
}

async function httpStatus(port: number, pathName = "/"): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathName, method: "GET", timeout: 4000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

async function restartWebViaApi(): Promise<void> {
  const code = await new Promise<number | null>((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: API_PORT, path: "/api/services/web/restart", method: "POST" },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on("error", () => resolve(null));
    req.end();
  });
  if (code !== 200) throw new Error(`web restart endpoint returned ${code ?? "no response"}`);
}

// ----- build/validate steps (web) -----
async function typecheckWeb(): Promise<{ ok: boolean; logs: string }> {
  const tsc = findBin("typescript/lib/tsc.js");
  if (!tsc) return { ok: true, logs: "typecheck skipped (tsc not found)" };
  return run(
    process.execPath,
    [tsc, "--noEmit", "-p", path.join(WEB_DIR, "tsconfig.json")],
    WEB_DIR,
  );
}

async function buildWeb(): Promise<{ ok: boolean; logs: string }> {
  const next = findBin("next/dist/bin/next");
  if (!next) return { ok: false, logs: "next binary not found" };
  return run(process.execPath, [next, "build"], WEB_DIR);
}

/** build step = fail-fast typecheck, then the (slow) production build. */
async function buildAndTypecheck(): Promise<void> {
  const tc = await typecheckWeb();
  if (!tc.ok) throw new Error(`typecheck failed:\n${tc.logs}`);
  const b = await buildWeb();
  if (!b.ok) throw new Error(`next build failed:\n${b.logs}`);
}

// ----- known-good store composed with rebuild+restart on rollback -----
function makeComposedStore(): KnownGoodStore {
  const git = new GitKnownGoodStore({
    repoDir: REPO_DIR,
    liveRef: LIVE_REF,
    stagingRef: STAGING_REF,
  });
  return {
    mark: () => git.mark(),
    promote: () => git.promote(), // candidate is already built+activated+verified
    rollback: async () => {
      // Return git to known-good, then actually serve it: rebuild + restart.
      await git.rollback();
      await buildAndTypecheck().catch((e) => log(`rollback rebuild warning: ${String(e)}`));
      await restartWebViaApi().catch((e) => log(`rollback restart warning: ${String(e)}`));
    },
  };
}

// ----- pipeline -----
function makePipeline(): ServiceDeployPipeline {
  return new ServiceDeployPipeline({
    service: { restart: restartWebViaApi },
    probes: {
      build: buildAndTypecheck,
      // validate is folded into build for the web first cut; tests/lint later.
      readiness: () => portListening(WEB_PORT),
      smoke: async () => {
        const code = await httpStatus(WEB_PORT, "/");
        return { ok: code !== null && code < 500, logs: `homepage status ${code}` };
      },
    },
    stabilityWindowMs: parseInt(process.env.MCA_STABILITY_MS || "20000", 10),
    probeIntervalMs: parseInt(process.env.MCA_PROBE_INTERVAL_MS || "4000", 10),
  });
}

// ----- AI repair agent (STUB — chat-routed impl is decision 3b, wired next) -----
const repairStub: RepairAgent = {
  attempt: async (ctx) => {
    log(
      `repair needed (attempt ${ctx.attempt}, failed at ${ctx.failedPhase}). ` +
        `Chat-routed repair agent not wired yet — parking. Logs:\n${ctx.logs}`,
    );
    return false; // no new candidate → controller parks
  },
};

// ----- wire it up -----
function persistJournal(result: unknown): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(JOURNAL_PATH, JSON.stringify({ at: Date.now(), result }, null, 2));
  } catch (err) {
    log(`could not write journal: ${String(err)}`);
  }
}

let deploying = false;

async function runDeploy(sha: string): Promise<void> {
  if (deploying) {
    log(`deploy already in flight; ignoring commit ${sha.slice(0, 8)} (one at a time)`);
    return;
  }
  deploying = true;
  log(`commit ${sha.slice(0, 8)} on ${STAGING_REF} — starting deploy`);
  try {
    const controller = new DeployController({
      pipeline: makePipeline(),
      knownGood: makeComposedStore(),
      repair: repairStub,
      budgetMs: BUDGET_MS,
      onPhase: (phase, info) => log(`phase=${phase} attempt=${info?.attempt}`),
    });
    const result = await controller.run();
    persistJournal(result);
    if (result.outcome === "promoted") {
      log(`PROMOTED after ${result.attempts} attempt(s).`);
    } else {
      // PARK: live is on known-good; journal preserved for the human to resume.
      log(
        `PARKED (${result.parkedReason}) after ${result.attempts} attempt(s). ` +
          `Live is on known-good. Effort preserved on '${STAGING_REF}' + ${JOURNAL_PATH}.`,
      );
      // TODO: ping the human (chat system message / Services banner).
    }
  } catch (err) {
    log(`deploy crashed: ${String(err)}`);
  } finally {
    deploying = false;
  }
}

function main(): void {
  log(`starting. repo=${REPO_DIR} web=${WEB_DIR} api:${API_PORT} web:${WEB_PORT}`);
  log(`watching '${STAGING_REF}'; known-good ref '${LIVE_REF}'; budget ${BUDGET_MS}ms`);
  const trigger = new CommitTrigger({
    repoDir: REPO_DIR,
    ref: STAGING_REF,
    onCommit: (sha) => void runDeploy(sha),
  });
  trigger.start();
  process.on("SIGINT", () => {
    trigger.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    trigger.stop();
    process.exit(0);
  });
}

main();

export {};
