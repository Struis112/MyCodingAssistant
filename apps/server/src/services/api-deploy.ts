// API deploy probes + activatable (Phase 4 — apps/server under the contract).
//
// The web has been gated by build → validate → activate → verify since Phase 2.
// The API server was deliberately out of scope at first because activating it
// means restarting the very process the deployer talked to. This module fills
// that gap so a commit on `staging` that touches `apps/server/**` (or
// `packages/shared/**`, which the server typechecks against) is gated by the
// same contract as the web.
//
// Activation strategy: bounce the NSSM service. The deployer process is a
// SEPARATE NSSM service (see start-deployer.ts) so it survives the API
// restart and can keep driving the rollback path if verification fails. The
// deployer must therefore have the same activation contract the web has:
//
//   ServiceDeployPipeline
//     ├─ build   : typecheck + `tsc -p apps/server` (emits dist/)
//     ├─ validate: vitest run (server tests) — optional, skipped when not configured
//     ├─ activate: nssm restart MyCodingAssistant
//     └─ verify  : readiness on PORT (TCP) + smoke GET /healthz
//
// All side-effecting calls (spawn, tcp connect, http GET) are injectable so
// the unit tests don't shell out.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Activatable, ServiceProbes } from "./service-deploy-pipeline.js";
import { ServiceDeployPipeline } from "./service-deploy-pipeline.js";

export interface ApiDeployRunResult {
  ok: boolean;
  logs: string;
}

export interface ApiDeployDeps {
  /** Repository root (workspace root). */
  repoDir: string;
  /** The NSSM service name to restart on activation. */
  serviceName: string;
  /** Path to nssm.exe (resolved by the caller, e.g. tools/nssm/nssm.exe). */
  nssmPath: string;
  /** Port the API listens on (for readiness + smoke). */
  apiPort: number;
  /** Override the `npm` binary (tests). Default "npm". */
  npmBin?: string;
  /**
   * Override the spawn-and-collect runner (tests). Default: real spawn that
   * captures combined stdout+stderr and resolves with exit-code success.
   */
  run?: (cmd: string, args: string[], cwd: string) => Promise<ApiDeployRunResult>;
  /** Injectable TCP probe (tests). Default real socket connect. */
  portListening?: (port: number) => Promise<boolean>;
  /** Injectable HTTP probe (tests). Default real http.request. */
  httpStatus?: (port: number, pathName: string) => Promise<number | null>;
  /** Injectable sleep for the pipeline's stability window. */
  sleep?: (ms: number) => Promise<void>;
  /** Stability window override (default 20s — server boots quickly). */
  stabilityWindowMs?: number;
  /** Probe interval override (default 3s). */
  probeIntervalMs?: number;
}

// ---- default external-effect implementations ----

function defaultRun(cmd: string, args: string[], cwd: string): Promise<ApiDeployRunResult> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Resolve through cmd.exe on Windows so PATH lookups for `npm`/`nssm` work.
      shell: process.platform === "win32",
    });
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", (d) => (out += d.toString()));
    proc.on("exit", (code) => resolve({ ok: code === 0, logs: out.trim() }));
    proc.on("error", (err) => resolve({ ok: false, logs: String(err) }));
  });
}

function defaultPortListening(port: number): Promise<boolean> {
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

function defaultHttpStatus(port: number, pathName: string): Promise<number | null> {
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

// ---- public factories ----

/**
 * Build the API server's probes. `build` runs `tsc` against the server
 * workspace (catches the import-time class of errors that bit us 2026-06-10);
 * `validate` runs vitest. Both are skipped silently if the relevant tool isn't
 * present, so a fresh checkout pre-`npm install` doesn't fail the contract.
 */
export function createApiProbes(deps: ApiDeployDeps): ServiceProbes {
  const run = deps.run ?? defaultRun;
  const npmBin = deps.npmBin ?? "npm";
  const serverDir = path.join(deps.repoDir, "apps", "server");
  const port = deps.apiPort;
  const portListening = deps.portListening ?? defaultPortListening;
  const httpStatus = deps.httpStatus ?? defaultHttpStatus;

  return {
    build: async () => {
      // `npm run build --workspace=@mca/server` runs `tsc` — emits dist/ AND
      // surfaces every type error. Failure throws so the pipeline returns
      // ok:false with the tsc output (which is exactly what the AI repair
      // loop needs to fix).
      const r = await run(npmBin, ["run", "build", "--workspace=@mca/server"], deps.repoDir);
      if (!r.ok) throw new Error(`build failed:\n${r.logs}`);
    },
    validate: async () => {
      // Server unit tests. We only run them if the workspace actually has a
      // `test` script — knip / a fresh repo shouldn't fail on its absence.
      const pkg = path.join(serverDir, "package.json");
      if (!existsSync(pkg)) return { ok: true, logs: "no server package.json — skipped" };
      const r = await run(
        npmBin,
        ["run", "test", "--workspace=@mca/server", "--if-present"],
        deps.repoDir,
      );
      return { ok: r.ok, logs: r.logs };
    },
    readiness: () => portListening(port),
    smoke: async () => {
      // /healthz is the public liveness probe — no auth, no deps, just "process
      // is alive and serving HTTP". Anything < 500 counts; 5xx means the
      // candidate is up but broken, which is exactly what we want to roll back.
      const code = await httpStatus(port, "/healthz");
      return {
        ok: code !== null && code < 500,
        logs: `GET /healthz -> ${code === null ? "no response" : code}`,
      };
    },
  };
}

/**
 * Activatable that bounces the NSSM-managed API service.
 *
 * Implementation: split stop + start (NOT `nssm restart`). NSSM's single-shot
 * `restart` is too strict about transient state — if the service is mid-
 * SERVICE_START_PENDING (which happens routinely when the OS just brought it
 * up), NSSM aborts with "Unexpected status SERVICE_START_PENDING in response
 * to START control" and we fail activate. The fix is to do the two halves
 * explicitly and tolerate "already stopped" / "already running" on each:
 * we don't actually CARE if the start nudge no-ops because the pipeline's
 * `verify` step probes readiness anyway. The activate step's real job is
 * "make sure a restart attempt happened"; verify decides if it stuck.
 *
 * Failure (return non-ok) is reserved for true terminal cases: NSSM not
 * found, service name doesn't exist.
 */
export function createApiActivatable(deps: ApiDeployDeps): Activatable {
  const run = deps.run ?? defaultRun;
  // Tolerated NSSM stderr fragments. Match against decoded-UTF16 (Windows
  // services often emit double-byte) by stripping NUL bytes first.
  const isTolerable = (logs: string): boolean => {
    // NSSM emits UTF-16 on Windows; strip the inter-byte NULs before matching
    // so substrings like 'SERVICE_START_PENDING' actually find each other.
    // String.replaceAll avoids the no-control-regex lint rule.
    const norm = logs.replaceAll("\u0000", "").toLowerCase();
    return (
      norm.includes("service has not been started") ||
      norm.includes("start_pending") ||
      norm.includes("stop_pending") ||
      norm.includes("operation completed successfully")
    );
  };
  // Returns ok:true if the call succeeded OR if it failed in a way we know is
  // safe to ignore during a bounce.
  const nssmTolerant = async (verb: "stop" | "start"): Promise<ApiDeployRunResult> => {
    const r = await run(deps.nssmPath, [verb, deps.serviceName], deps.repoDir);
    if (r.ok) return r;
    if (isTolerable(r.logs)) return { ok: true, logs: `[tolerated] ${r.logs}` };
    return r;
  };
  return {
    restart: async () => {
      const stop = await nssmTolerant("stop");
      if (!stop.ok) {
        throw new Error(`nssm stop ${deps.serviceName} failed:\n${stop.logs}`);
      }
      // Brief pause so the SCM finishes the state transition before we ask
      // for START. Without this, back-to-back stop/start can race on slow
      // shutdowns and re-trip the SERVICE_*_PENDING guard.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const start = await nssmTolerant("start");
      if (!start.ok) {
        throw new Error(`nssm start ${deps.serviceName} failed:\n${start.logs}`);
      }
    },
  };
}

/** Convenience: wire the probes + activatable into a ServiceDeployPipeline. */
export function createApiDeployPipeline(deps: ApiDeployDeps): ServiceDeployPipeline {
  return new ServiceDeployPipeline({
    service: createApiActivatable(deps),
    probes: createApiProbes(deps),
    stabilityWindowMs: deps.stabilityWindowMs ?? 20_000,
    probeIntervalMs: deps.probeIntervalMs ?? 3_000,
    sleep: deps.sleep,
  });
}
