// API deploy probes + activatable (Phase 4 — apps/server under the contract).
//
// The web has been gated by build → validate → activate → verify since Phase 2.
// The API server was deliberately out of scope at first because activating it
// means restarting the very process the deployer talked to. This module fills
// that gap so a commit on `staging` that touches `apps/server/**` (or
// `packages/shared/**`, which the server typechecks against) is gated by the
// same contract as the web.
//
// Activation strategy: `pm2 restart mca-server`. The deployer is a SEPARATE
// PM2 app (see start-deployer.ts / ecosystem.config.cjs) so restarting the
// API never kills the deployer — it keeps driving the rollback path if
// verification fails. PM2 (not the deployer) owns every process lifecycle;
// the deployer only ever asks PM2 to restart. The deployer therefore has the
// same activation contract the web has:
//
//   ServiceDeployPipeline
//     ├─ build   : typecheck + `tsc -p apps/server` (emits dist/)
//     ├─ validate: vitest run (server tests) — optional, skipped when not configured
//     ├─ activate: pm2 restart mca-server
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
  /** The PM2 app name to restart on activation (e.g. "mca-server"). */
  appName: string;
  /** Path to the pm2 bin JS (run with node), e.g. node_modules/pm2/bin/pm2. */
  pm2Bin: string;
  /** Node binary used to run pm2 (default process.execPath). */
  nodeBin?: string;
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
  /** How long to wait for /healthz=200 after pm2 restart (default 180s). */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for ready (default 1s). */
  readyProbeIntervalMs?: number;
}

// ---- default external-effect implementations ----

function defaultRun(cmd: string, args: string[], cwd: string): Promise<ApiDeployRunResult> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Resolve through cmd.exe on Windows so PATH lookups for `npm`/`pm2` work.
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

/**
 * Reusable: poll /healthz on `port` with `intervalMs` cadence until it
 * returns 200, or `timeoutMs` elapses. Throws with the last-seen status on
 * timeout. Used by createApiActivatable (activate path) and also by the
 * deployer's rollback path, which needs the same "the API is really serving
 * again" guarantee after a pm2 restart before it moves on.
 */
export async function waitForApiReady(opts: {
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
  httpStatus?: (port: number, path: string) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const httpStatus = opts.httpStatus ?? defaultHttpStatus;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let lastSeen: number | null = -1;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const code = await httpStatus(opts.port, "/healthz");
    if (code === 200) return;
    lastSeen = code;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  throw new Error(
    `API did not become ready within ${Math.round(timeoutMs / 1000)}s ` +
      `(last /healthz status: ${lastSeen === null ? "no response" : lastSeen})`,
  );
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
 * Activatable that bounces the PM2-managed API app (`pm2 restart mca-server`).
 *
 * PM2 owns the process lifecycle; the deployer is a separate PM2 app, so this
 * restart never touches the deployer itself. PM2's restart is reliable and
 * has none of NSSM's transient-SERVICE_*_PENDING fragility, so there's no
 * "tolerated state" matching to do: a non-zero exit from `pm2 restart` is a
 * genuine failure (app name unknown, daemon down, ...) and we throw — the
 * composite pipeline turns that into a rollback.
 *
 * Wait-for-ready: after `pm2 restart` exits (PM2 returns as soon as it has
 * (re)spawned the process, NOT when the app is serving) we poll `/healthz`
 * until the API actually answers 200 (up to `readyTimeoutMs`, default 180s).
 * This makes "activate returned" mean "the API is up and answering HTTP", so
 * the composite pipeline's verify step — and the deployer's repair HTTP calls
 * — never hit a still-booting API (the 2026-06-10 incident class).
 */
export function createApiActivatable(deps: ApiDeployDeps): Activatable {
  const run = deps.run ?? defaultRun;
  const httpStatus = deps.httpStatus ?? defaultHttpStatus;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const port = deps.apiPort;
  const nodeBin = deps.nodeBin ?? process.execPath;
  // Generous on purpose. The window has to cover dev-precheck (~2.5s tsc),
  // the SDK init (~5-7s typical), and PM2's own restart_delay backoff if the
  // freshly-deployed code happens to crash-loop briefly. 180s = comfortable
  // margin. Better to wait 3 minutes for a healthy API than to roll back a
  // perfectly good deploy because the SDK was 25s into a 30s init.
  const readyTimeoutMs = deps.readyTimeoutMs ?? 180_000;
  const readyProbeIntervalMs = deps.readyProbeIntervalMs ?? 1_000;
  // Delegate to the shared helper so the activate path and the rollback
  // path use the same logic, with the same probe shape.
  const waitForReady = (): Promise<void> =>
    waitForApiReady({
      port,
      timeoutMs: readyTimeoutMs,
      intervalMs: readyProbeIntervalMs,
      httpStatus,
      sleep,
    });

  return {
    restart: async () => {
      // Plain `pm2 restart <name>` (no --update-env): PM2 reuses the env it
      // captured from the ecosystem file when the app was first started, so
      // PORT/HOST/NODE_ENV are preserved. --update-env would clobber them
      // with the DEPLOYER's environment, which lacks them.
      const r = await run(nodeBin, [deps.pm2Bin, "restart", deps.appName], deps.repoDir);
      if (!r.ok) {
        throw new Error(`pm2 restart ${deps.appName} failed:\n${r.logs}`);
      }
      // Wait for the API to actually serve before declaring activate done, so
      // verify (and the deployer's repair calls) never hit a booting API.
      await waitForReady();
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
