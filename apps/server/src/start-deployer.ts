// Self-Healing Deployer (Phase 2/4 entrypoint) — SEPARATE PROCESS
//
// See docs/architecture/self-healing-deploy.md. This is the small, rarely-
// changed process that owns deploys so it can roll back the app even when the
// app is broken. It runs as its OWN NSSM service (failure-domain isolation),
// as Administrator (repo owner) so git works.
//
// Scope: WEB + API (Phase 4 — "Bring `api` + `packages/shared` under the
// contract"). The API is activated by bouncing its NSSM service; the deployer
// is its OWN service so the bounce never kills the rollback path.
//
// Flow per commit on `staging` (composite across all children, in order):
//   build  (api: tsc-emit | web: typecheck + next build)
//   -> validate (api: vitest | web: built-in)
//   -> activate (api FIRST: nssm restart   |   web SECOND: /api/services/web/restart)
//   -> verify   (api: TCP + /healthz       |   web: TCP + /)
//   -> PROMOTE, else ROLL BACK to known-good (git reset + rebuild web + restart
//      both), feed logs to the AI, retry until stable or the 8h wall-clock
//      budget is spent, then PARK (journal preserved).
//
// Order matters: API restarts first so a new server contract is in place
// before the web reconnects. Verify is in the same order so a broken API
// surfaces before web verification (faster, more focused rollback signal).
//
// STATUS: integration glue — assembled from unit-tested modules
// (deploy-controller, git-known-good, service-deploy-pipeline,
// multi-service-deploy-pipeline, api-deploy, commit-trigger). The AI
// RepairAgent is a STUB (parks) until the chat-routed agent (decision 3b)
// is wired.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import { CommitTrigger } from "./services/commit-trigger.js";
import {
  DeployController,
  type DeployPipeline,
  type KnownGoodStore,
  type RepairAgent,
} from "./services/deploy-controller.js";
import { GitKnownGoodStore } from "./services/git-known-good.js";
import { ServiceDeployPipeline } from "./services/service-deploy-pipeline.js";
import { MultiServiceDeployPipeline } from "./services/multi-service-deploy-pipeline.js";
import { createApiDeployPipeline } from "./services/api-deploy.js";
import { resolveDeployToken } from "./services/deploy-token.js";
import { acquireDeployLock } from "./services/deploy-bounce-lock.js";

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
// API NSSM service name + nssm.exe location — mirrors install-windows.ps1.
const API_SERVICE_NAME = process.env.MCA_SERVICE_NAME || "MyCodingAssistant";
const NSSM_PATH = process.env.MCA_NSSM_PATH || path.join(REPO_DIR, "tools", "nssm", "nssm.exe");
// Toggle: include the API in the deploy contract (Phase 4). Defaults ON; set
// MCA_DEPLOY_INCLUDE_API=0 to fall back to web-only (e.g. while debugging).
const INCLUDE_API = process.env.MCA_DEPLOY_INCLUDE_API !== "0";

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
  // Retry on transient connection failures: when watch-safe or NSSM is mid-
  // bouncing the API server, /api/services/web/restart momentarily returns
  // ECONNREFUSED. The cooperative bounce-lock SHOULD prevent overlap, but
  // defence-in-depth retry costs almost nothing and saves the deploy attempt
  // when (not if) something else races. Backoff: 0.5/1/2/4s, max 4 attempts.
  const callOnce = (): Promise<number | null> =>
    new Promise<number | null>((resolve) => {
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
  let code: number | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    code = await callOnce();
    if (code !== null) break;
    if (attempt === 4) break;
    const delayMs = 500 * 2 ** (attempt - 1);
    log(`web restart endpoint unreachable (attempt ${attempt}/4) — retry in ${delayMs}ms`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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

// ----- spawn helper for the API pipeline (matches its `run` shape) -----
// `run()` above already returns {ok, logs}; api-deploy expects the same shape.
async function runForApi(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; logs: string }> {
  return run(cmd, args, cwd);
}

// ----- known-good store composed with rebuild+restart on rollback -----
async function rebuildAndRestartApi(): Promise<void> {
  // API rollback: rebuild (tsc emits dist/) then bounce the NSSM service.
  // Best-effort — we log warnings instead of throwing so a web-only failure
  // doesn't strand the system after a partial rollback.
  const built = await run("npm", ["run", "build", "--workspace=@mca/server"], REPO_DIR);
  if (!built.ok) log(`rollback API build warning: ${built.logs}`);
  // Same stop/start split as api-deploy.ts: `nssm restart` is too strict
  // about transient SERVICE_*_PENDING states and aborts on the routine
  // mid-transition race. Stop + sleep + start tolerates that.
  // NSSM emits UTF-16 — strip NULs before matching benign-state substrings.
  const stripNul = (s: string) => s.replaceAll("\u0000", "");
  const stop = await run(NSSM_PATH, ["stop", API_SERVICE_NAME], REPO_DIR);
  if (!stop.ok && !/start|stopped|completed/i.test(stripNul(stop.logs))) {
    log(`rollback API stop warning: ${stop.logs}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const start = await run(NSSM_PATH, ["start", API_SERVICE_NAME], REPO_DIR);
  if (!start.ok && !/start|running|completed/i.test(stripNul(start.logs))) {
    log(`rollback API start warning: ${start.logs}`);
  }
}

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
      // Return git to known-good, then actually serve it. Rebuild + restart
      // both children in the same order they were activated (API first, web
      // second) so the web restart picks up the rolled-back server contract.
      await git.rollback();
      if (INCLUDE_API) {
        await rebuildAndRestartApi().catch((e) => log(`rollback API warning: ${String(e)}`));
      }
      await buildAndTypecheck().catch((e) => log(`rollback web build warning: ${String(e)}`));
      await restartWebViaApi().catch((e) => log(`rollback web restart warning: ${String(e)}`));
    },
  };
}

// ----- pipelines -----
function makeWebPipeline(): ServiceDeployPipeline {
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

function makeApiPipeline(): ServiceDeployPipeline {
  return createApiDeployPipeline({
    repoDir: REPO_DIR,
    serviceName: API_SERVICE_NAME,
    nssmPath: NSSM_PATH,
    apiPort: API_PORT,
    run: runForApi,
    portListening: (p) => portListening(p),
    httpStatus: (p, pathName) => httpStatus(p, pathName),
    stabilityWindowMs: parseInt(process.env.MCA_API_STABILITY_MS || "20000", 10),
    probeIntervalMs: parseInt(process.env.MCA_API_PROBE_INTERVAL_MS || "3000", 10),
  });
}

function makePipeline(): DeployPipeline {
  const web = makeWebPipeline();
  if (!INCLUDE_API) return web;
  // API first so the web reconnects to a server already on the new contract.
  return new MultiServiceDeployPipeline({
    children: [
      { name: "api", pipeline: makeApiPipeline() },
      { name: "web", pipeline: web },
    ],
  });
}

// ----- AI repair agent (Phase 3 — chat-routed, autonomous) -----
// POSTs the failure context to the API server's /api/repair/prompt; that
// endpoint owns the dedicated "Self-healing deploy" chat session, sends the
// message to the AI, and resolves when either a new commit appears on
// `staging` (= retry) or the AI gives up (= park) or `remainingMs` runs out.
//
// We talk HTTP rather than running the agent in-process because the deployer
// is a separate failure-domain: keeping it stateless wrt the chat session
// means a deployer crash never loses repair-conversation context.
const DEPLOY_TOKEN = resolveDeployToken({ repoDir: REPO_DIR });
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const LOG_CAP_BYTES = 12 * 1024;

// Transient errors we'll retry on. Watch-safe + the API service's own
// restarts mean a POST to localhost can hit ECONNREFUSED for a few seconds
// even when the service is supposed to be running — the cooperative lock
// SHOULD prevent that for the activate window, but a defence-in-depth retry
// on these specific errors costs us almost nothing and saves the entire
// deploy attempt when (not if) something else races.
const TRANSIENT_HTTP_ERRORS = /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i;

function postJson<T>(
  pathName: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; data: T | null; error?: string }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port: API_PORT,
        path: pathName,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "X-MCA-Deploy-Token": DEPLOY_TOKEN,
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          try {
            const data = chunks ? (JSON.parse(chunks) as T) : null;
            resolve({ status: res.statusCode ?? 0, data });
          } catch (err) {
            resolve({ status: res.statusCode ?? 0, data: null, error: String(err) });
          }
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, data: null, error: String(err) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, data: null, error: `timeout after ${timeoutMs}ms` });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * postJson with exponential backoff on transient connection errors. The
 * deployer talks ONLY to localhost, so a transient ECONNREFUSED is virtually
 * always "the API is mid-restart" rather than a real failure — wait it out.
 *
 * Backoff schedule: 0.5s, 1s, 2s, 4s (up to ~7.5s extra wall-clock on top of
 * the per-call timeoutMs). Capped at 4 attempts because if it's STILL down
 * after that the API genuinely isn't coming back without intervention, and
 * we should surface the failure to the controller so it parks.
 */
async function postJsonWithRetry<T>(
  pathName: string,
  body: unknown,
  timeoutMs: number,
  opts: { maxAttempts?: number; logRetries?: boolean } = {},
): Promise<{ status: number; data: T | null; error?: string }> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const logRetries = opts.logRetries ?? true;
  let lastResult: { status: number; data: T | null; error?: string } | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await postJson<T>(pathName, body, timeoutMs);
    lastResult = r;
    // Success path: any HTTP response (even 4xx/5xx) means the API is up and
    // talking to us — don't retry, let the caller decide what to do.
    if (r.status !== 0) return r;
    // Transient connection error — retry with backoff (unless we're out of
    // attempts).
    const transient = r.error && TRANSIENT_HTTP_ERRORS.test(r.error);
    if (!transient || attempt === maxAttempts) return r;
    const delayMs = 500 * 2 ** (attempt - 1); // 500, 1000, 2000, 4000
    if (logRetries) {
      log(
        `${pathName} hit transient error (${r.error}) on attempt ${attempt}/${maxAttempts} — retry in ${delayMs}ms`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return lastResult ?? { status: 0, data: null, error: "no attempts made" };
}

const chatRoutedRepair: RepairAgent = {
  attempt: async (ctx) => {
    // Cap logs so the IPC payload stays reasonable; the API server caps again.
    const logs =
      ctx.logs.length > LOG_CAP_BYTES
        ? `[…truncated…]\n${ctx.logs.slice(-LOG_CAP_BYTES)}`
        : ctx.logs;
    log(
      `requesting repair (attempt ${ctx.attempt}, failed at ${ctx.failedPhase}, ~${Math.round(
        ctx.remainingMs / 60_000,
      )}min left). API: ${API_BASE}/api/repair/prompt`,
    );
    // HTTP timeout: a bit longer than the AI's budget so the API server can
    // resolve naturally; if we time out first we just park.
    const timeoutMs = Math.min(ctx.remainingMs + 30_000, 8 * 60 * 60 * 1000);
    const r = await postJsonWithRetry<{ newSha: string | null; reason: string }>(
      "/api/repair/prompt",
      {
        attempt: ctx.attempt,
        failedPhase: ctx.failedPhase,
        logs,
        elapsedMs: ctx.elapsedMs,
        remainingMs: ctx.remainingMs,
      },
      timeoutMs,
    );
    if (r.status !== 200 || !r.data) {
      log(`repair endpoint returned ${r.status}${r.error ? ` (${r.error})` : ""} — parking.`);
      return false;
    }
    if (r.data.newSha) {
      log(`AI committed ${r.data.newSha.slice(0, 8)} (reason=${r.data.reason}). retrying.`);
      return true;
    }
    log(`AI did not commit a fix (reason=${r.data.reason}). parking.`);
    return false;
  },
};

async function notifyParked(
  result: { attempts: number; parkedReason?: string },
  liveSha: string | undefined,
): Promise<void> {
  const r = await postJsonWithRetry<{ ok: true }>(
    "/api/repair/parked",
    {
      reason: result.parkedReason ?? "unknown",
      attempts: result.attempts,
      liveSha,
    },
    10_000,
  );
  if (r.status !== 200) {
    log(`park notification failed (status ${r.status}${r.error ? `: ${r.error}` : ""})`);
  }
}

async function currentLiveSha(): Promise<string | undefined> {
  const r = await run("git", ["-C", REPO_DIR, "rev-parse", LIVE_REF], REPO_DIR);
  return r.ok ? r.logs.trim() || undefined : undefined;
}

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

  // Acquire the cooperative bounce lock for the FULL deploy. The lock signals
  // to the API server's in-process WatchSafeRestarter that we're going to
  // bounce the service shortly — watch-safe abstains while the lock is fresh
  // so it doesn't take the API down concurrently with our activate phase.
  // Held across build/validate/activate/verify AND any rollback work, so the
  // window is unambiguous: while this lock exists, ONLY the deployer touches
  // service lifecycle. Released in finally{} so a deploy crash never leaves
  // a wedged lock (stale-detection in deploy-bounce-lock.ts is the secondary
  // safety net for an OS-level kill where finally{} can't run).
  const lockHandle = acquireDeployLock(REPO_DIR, "deploying", { sha });
  try {
    const controller = new DeployController({
      pipeline: makePipeline(),
      knownGood: makeComposedStore(),
      repair: chatRoutedRepair,
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
      // Ping the human via the API (chat system-message + socket event).
      // Best effort: the API may itself be wedged — we already logged + journaled.
      await notifyParked(result, await currentLiveSha()).catch((err) =>
        log(`park notification crashed: ${String(err)}`),
      );
    }
  } catch (err) {
    log(`deploy crashed: ${String(err)}`);
  } finally {
    lockHandle.release();
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

  // Keep the event loop alive. CommitTrigger.start()'s poll interval is
  // .unref()'d for test ergonomics, so without this keepalive the deployer
  // process exits immediately after main() returns — NSSM then restarts us
  // in a tight loop. The keepalive is intentionally a no-op heartbeat:
  // it costs nothing, it shows up in tracing as proof of life, and it makes
  // the "why is this process still alive?" question trivial to answer.
  const heartbeat = setInterval(() => {
    /* no-op: this interval exists solely to keep the event loop alive. */
  }, 60_000);

  const shutdown = (signal: string) => {
    log(`received ${signal} — stopping`);
    trigger.stop();
    clearInterval(heartbeat);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Windows: NSSM's default stop sends a console Ctrl+Break, surfaced as SIGBREAK.
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

main();

export {};
