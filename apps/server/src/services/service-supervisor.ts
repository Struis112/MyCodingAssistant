// Generic Service Supervisor
//
// Keeps a long-running child process alive and current. Every supervised
// service in MyCodingAssistant follows the same standards (see AGENTS.md):
//
//   1. Hot-reload   — watch source paths; on change, rebuild + restart so the
//                     running service always serves the latest code.
//   2. Self-repair  — on an unexpected crash, inspect the recent logs, attempt
//                     a known fix, then restart. Restarts are rate-limited to
//                     ONCE PER MINUTE with a MAXIMUM OF 50 attempts, after which
//                     the service is parked in `failed` (manual restart only).
//   3. Inventory    — exposes a structured status + a rolling log buffer so the
//                     "Services" screen can list and control every service.
//
// This module is process/runtime-agnostic: callers describe a service via a
// `ServiceSpec` (how to spawn it, what to watch, how to repair it) and the
// supervisor handles the lifecycle.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

/** Fixed retry cadence + cap, per the project-wide self-repair standard. */
export const DEFAULT_RESTART_INTERVAL_MS = 60_000; // retry once per minute
export const DEFAULT_MAX_RESTARTS = 50; // give up after 50 tries
const DEFAULT_LOG_LINES = 200;
const DEFAULT_REBUILD_DEBOUNCE_MS = 400;
/** Grace period after SIGTERM before we escalate to SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** Hard cap after SIGKILL before we stop waiting for `exit` and resolve anyway. */
const KILL_HARD_TIMEOUT_MS = 2_000;

export type ServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "validating"
  | "rebuilding"
  | "repairing"
  | "backoff"
  | "failed";

/** A single captured log line with origin + timestamp. */
export interface LogLine {
  ts: number;
  stream: "out" | "err" | "sys";
  text: string;
}

/** Structured, serialisable snapshot of a service for the UI + /health. */
export interface ServiceStatus {
  name: string;
  description: string;
  state: ServiceState;
  pid?: number;
  port?: number;
  /** When the current process was spawned (ms epoch). */
  startedAt?: number;
  /** How long the current process has been up (ms). */
  uptimeMs?: number;
  /** Crash-driven restart count (hot-reload restarts don't count). */
  restarts: number;
  maxRestarts: number;
  /** When the next crash-restart will fire (ms epoch), while in backoff. */
  nextRestartAt?: number;
  /** Most recent failure reason, if any. */
  lastError?: string;
  /** Last self-repair note, if a repair hook ran. */
  lastRepair?: string;
  /** True when this service watches its source and auto-serves the latest build. */
  hotReloadEnabled: boolean;
  /** Short run-profile label for the UI (e.g. "dev", "prod"). Optional. */
  mode?: string;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ServiceSpec {
  name: string;
  description: string;
  /** Short run-profile label for the UI (e.g. "dev", "prod"). Optional. */
  mode?: string;
  /** Build the spawn invocation. Thrown errors surface as `failed`. */
  resolveCommand: () => ResolvedCommand;
  /** TCP port this service listens on (for display + conflict checks). */
  port?: number;
  /**
   * Optional pre-spawn gate. Return `{ ok: false, reason }` to refuse to
   * start (e.g. missing build artifacts, port already taken). The reason is
   * shown verbatim in the Services screen.
   */
  preflight?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Hot-reload config. When any file under `paths` changes, the supervisor
   * debounces, runs `rebuild` (if given), then restarts the process so the
   * latest code is served. Hot-reload restarts do NOT count toward maxRestarts.
   */
  watch?: { paths: string[]; rebuild?: () => Promise<void>; debounceMs?: number };
  /**
   * Self-repair hook. Called on an unexpected crash BEFORE the restart timer
   * is scheduled, with the recent log lines. Use it to detect known failure
   * modes and remediate (e.g. rebuild when artifacts are stale). Return a
   * human note describing what was done; it's surfaced as `lastRepair`.
   */
  repair?: (logs: LogLine[]) => Promise<{ repaired: boolean; note?: string }>;
  /**
   * Deploy contract (Phase 1 — see docs/architecture/self-healing-deploy.md).
   * Validate a candidate change BEFORE activating it, so a broken edit never
   * disturbs the currently-serving version. Runs when a hot-reload change is
   * detected, before rebuild/restart. Return `ok:false` to abort activation
   * and keep the current version. (Automatic rollback of an already-activated
   * change is Phase 2.)
   */
  validate?: () => Promise<{ ok: boolean; logs?: string }>;
  /** Readiness probe: is the service ready to serve right now? */
  readiness?: () => Promise<boolean>;
  /** Liveness probe: is it healthy over time (catches alive-but-wedged)? */
  liveness?: () => Promise<boolean>;
  /** Smoke test after activation (hit an endpoint / render a page). */
  smoke?: () => Promise<{ ok: boolean; logs?: string }>;
  /** Services that must be healthy before this one (deploy/rollback order). */
  dependsOn?: string[];
  /** Source paths/workspaces this service builds from. */
  sources?: string[];
  restartIntervalMs?: number;
  maxRestarts?: number;
  logBufferLines?: number;
}

/**
 * Supervises one child process. Construct with a {@link ServiceSpec}, call
 * {@link start}; the supervisor then keeps it alive + current until {@link stop}.
 */
export class ServiceSupervisor extends EventEmitter {
  readonly name: string;
  readonly description: string;

  private spec: ServiceSpec;
  private restartIntervalMs: number;
  private maxRestarts: number;
  private logBufferLines: number;

  private proc: ChildProcess | null = null;
  private state: ServiceState = "stopped";
  private restarts = 0;
  private shouldRun = false;
  /** True while we are deliberately killing the child (stop/restart/hot-reload). */
  private intentionalKill = false;
  private startedAt = 0;
  private lastError?: string;
  private lastRepair?: string;
  private nextRestartAt?: number;

  private restartTimer: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private rebuildTimer: NodeJS.Timeout | null = null;
  private logs: LogLine[] = [];

  constructor(spec: ServiceSpec) {
    super();
    this.spec = spec;
    this.name = spec.name;
    this.description = spec.description;
    this.restartIntervalMs = spec.restartIntervalMs ?? DEFAULT_RESTART_INTERVAL_MS;
    this.maxRestarts = spec.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.logBufferLines = spec.logBufferLines ?? DEFAULT_LOG_LINES;
  }

  getStatus(): ServiceStatus {
    return {
      name: this.name,
      description: this.description,
      mode: this.spec.mode,
      state: this.state,
      pid: this.proc?.pid,
      port: this.spec.port,
      startedAt: this.state === "running" ? this.startedAt : undefined,
      uptimeMs:
        this.state === "running" && this.startedAt ? Date.now() - this.startedAt : undefined,
      restarts: this.restarts,
      maxRestarts: this.maxRestarts,
      nextRestartAt: this.state === "backoff" ? this.nextRestartAt : undefined,
      lastError: this.lastError,
      lastRepair: this.lastRepair,
      hotReloadEnabled: !!this.spec.watch,
    };
  }

  getLogs(limit = this.logBufferLines): LogLine[] {
    return limit >= this.logs.length ? [...this.logs] : this.logs.slice(-limit);
  }

  async start(): Promise<void> {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.restarts = 0;
    this.lastError = undefined;

    const preflight = this.spec.preflight ? await this.spec.preflight() : { ok: true as const };
    if (!preflight.ok) {
      this.shouldRun = false;
      this.fail(preflight.reason);
      return;
    }

    this.spawnNow();
    this.startWatching();
  }

  stop(): Promise<void> {
    this.shouldRun = false;
    this.clearRestartTimer();
    this.stopWatching();
    return this.killCurrent().then(() => {
      this.setState("stopped");
    });
  }

  /** Manual restart (UI button / hot-reload). Resets the crash counter. */
  async restart(): Promise<void> {
    const was = this.shouldRun;
    await this.killCurrent();
    this.restarts = 0;
    this.lastError = undefined;
    this.clearRestartTimer();
    if (was || !this.proc) {
      this.shouldRun = true;
      this.spawnNow();
      this.startWatching();
    }
  }

  // ----- internals -----

  private spawnNow(): void {
    let cmd: ResolvedCommand;
    try {
      cmd = this.spec.resolveCommand();
    } catch (err) {
      this.shouldRun = false;
      this.fail(`Cannot resolve launch command: ${String(err)}`);
      return;
    }

    this.startedAt = Date.now();
    this.setState("starting");
    this.pushLog("sys", `starting: ${cmd.command} ${cmd.args.join(" ")}`);

    const proc = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d) => this.ingest("out", d));
    proc.stderr?.on("data", (d) => this.ingest("err", d));

    proc.on("spawn", () => {
      if (proc.pid !== undefined) this.setState("running");
    });

    proc.on("exit", (code, signal) => {
      this.proc = null;
      this.pushLog("sys", `exited code=${code} signal=${signal ?? "none"}`);
      // A deliberate kill (stop/restart/hot-reload) is not a crash — never run
      // crash recovery for it, or we'd schedule a stray backoff restart on top
      // of the fresh process and leave the service parked in backoff/failed.
      if (this.intentionalKill) {
        this.intentionalKill = false;
        if (!this.shouldRun) this.setState("stopped");
        return;
      }
      if (!this.shouldRun) {
        this.setState("stopped");
        return;
      }
      void this.handleCrash(`exit code=${code} signal=${signal ?? "none"}`);
    });

    proc.on("error", (err) => {
      this.pushLog("err", `spawn error: ${String(err)}`);
    });

    this.proc = proc;
  }

  /** Crash recovery: self-repair, then rate-limited restart (1/min, max N). */
  private async handleCrash(reason: string): Promise<void> {
    this.lastError = reason;
    this.restarts += 1;

    if (this.restarts > this.maxRestarts) {
      this.fail(`Exceeded max restarts (${this.maxRestarts}): ${reason}`);
      return;
    }

    // Best-effort self-repair using recent logs.
    if (this.spec.repair) {
      this.setState("repairing");
      try {
        const result = await this.spec.repair(this.getLogs());
        if (result.note) {
          this.lastRepair = result.note;
          this.pushLog("sys", `repair: ${result.note}`);
        }
      } catch (err) {
        this.pushLog("err", `repair hook failed: ${String(err)}`);
      }
      if (!this.shouldRun) return;
    }

    this.nextRestartAt = Date.now() + this.restartIntervalMs;
    this.setState("backoff");
    this.pushLog(
      "sys",
      `restart attempt ${this.restarts}/${this.maxRestarts} in ${Math.round(this.restartIntervalMs / 1000)}s`,
    );
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shouldRun) this.spawnNow();
    }, this.restartIntervalMs);
  }

  // ----- hot reload -----

  private startWatching(): void {
    if (!this.spec.watch || this.watchers.length > 0) return;
    for (const p of this.spec.watch.paths) {
      try {
        const w = watch(p, { recursive: true }, (_event, file) => {
          // Ignore noise: dotfiles, build outputs, sourcemaps.
          if (file && /(^|[\\/])(\.|node_modules|\.next|dist)([\\/]|$)/.test(file)) return;
          this.queueRebuild();
        });
        this.watchers.push(w);
      } catch {
        this.pushLog("sys", `hot-reload watch unavailable for ${p}`);
      }
    }
  }

  private stopWatching(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
  }

  private queueRebuild(): void {
    const debounce = this.spec.watch?.debounceMs ?? DEFAULT_REBUILD_DEBOUNCE_MS;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuildAndRestart();
    }, debounce);
  }

  private async rebuildAndRestart(): Promise<void> {
    if (!this.shouldRun) return;

    // ---- Validation gate (deploy contract, Phase 1) ----
    // Catch a broken change BEFORE building/activating, so the currently
    // serving version is never disturbed by a bad edit. Automatic rollback of
    // an already-activated change is Phase 2 (see the self-healing-deploy doc).
    const validate = this.spec.validate;
    if (validate) {
      this.setState("validating");
      this.pushLog("sys", "change detected — validating before activating");
      let result: { ok: boolean; logs?: string };
      try {
        result = await validate();
      } catch (err) {
        result = { ok: false, logs: String(err) };
      }
      if (!this.shouldRun) return;
      if (!result.ok) {
        this.lastError = "Validation failed — kept the current version.";
        if (result.logs) this.pushLog("err", `validation failed:\n${result.logs}`);
        this.pushLog("sys", "validation gate: keeping current version");
        // We never touched the running version; reflect its real state.
        this.setState(this.proc ? "running" : "stopped");
        return;
      }
      this.pushLog("sys", "validation passed — proceeding to activate");
    }

    const rebuild = this.spec.watch?.rebuild;
    if (rebuild) {
      this.setState("rebuilding");
      this.pushLog("sys", "rebuilding for hot-reload");
      try {
        await rebuild();
      } catch (err) {
        this.pushLog("err", `rebuild failed, keeping current version: ${String(err)}`);
        // Don't get stuck in 'rebuilding' — reflect the real (untouched) state.
        this.setState(this.proc ? "running" : "stopped");
        return;
      }
    }
    this.pushLog("sys", "activating — restarting to serve latest version");
    await this.restart();
    this.emitStatus();

    // Post-activation readiness check (Phase 1: observe + log only; automatic
    // rollback on failure arrives with the deployer in Phase 2).
    void this.probeReadinessAfterActivate();
  }

  /**
   * Phase 1: after activation, check readiness once (if a probe is provided)
   * and log the result. Automatic rollback on a failed probe arrives with the
   * deployer (Phase 2 — see docs/architecture/self-healing-deploy.md).
   */
  private async probeReadinessAfterActivate(): Promise<void> {
    const readiness = this.spec.readiness;
    if (!readiness) return;
    try {
      const ready = await readiness();
      this.pushLog(
        ready ? "sys" : "err",
        ready
          ? "readiness probe passed after activation"
          : "readiness probe FAILED after activation (auto-rollback arrives in Phase 2)",
      );
    } catch (err) {
      this.pushLog("err", `readiness probe error after activation: ${String(err)}`);
    }
    this.emitStatus();
  }

  // ----- helpers -----

  private killCurrent(): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = this.proc;
      if (!child) {
        resolve();
        return;
      }
      // Mark this as a deliberate shutdown so the exit handler skips crash
      // recovery for the process we are about to terminate.
      this.intentionalKill = true;

      // Track actual termination via the `exit` event. NB: `child.killed` only
      // means "a signal was delivered", not "the process died" — so we must not
      // gate escalation on it. We resolve exactly once, on real exit or a hard
      // timeout, and always clear our timers so nothing leaks.
      let settled = false;
      let graceTimer: NodeJS.Timeout | null = null;
      let hardTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve();
      };

      child.once("exit", finish);

      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone (or un-signalable) — nothing to wait for.
        finish();
        return;
      }

      // If SIGTERM is ignored/blocked, escalate to SIGKILL after a grace period.
      // (On Windows both map to TerminateProcess, so the child is already gone
      // by now and this is a harmless no-op.)
      graceTimer = setTimeout(() => {
        if (settled) return;
        this.pushLog("sys", "SIGTERM grace elapsed — escalating to SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        // Guarantee the promise resolves even if `exit` never arrives, so
        // stop()/restart() can never hang forever.
        hardTimer = setTimeout(finish, KILL_HARD_TIMEOUT_MS);
      }, KILL_GRACE_MS);
    });
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private ingest(stream: "out" | "err", chunk: Buffer | string): void {
    const text = chunk.toString();
    const prefix = stream === "err" ? `[${this.name}!]` : `[${this.name}]`;
    process[stream === "err" ? "stderr" : "stdout"].write(`${prefix} ${text}`);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this.pushLog(stream, line);
    }
  }

  private pushLog(stream: LogLine["stream"], text: string): void {
    this.logs.push({ ts: Date.now(), stream, text });
    if (this.logs.length > this.logBufferLines) {
      this.logs.splice(0, this.logs.length - this.logBufferLines);
    }
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.pushLog("err", reason);
    this.setState("failed");
  }

  private setState(state: ServiceState): void {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }
}

/** Resolve an absolute, recursive-watchable directory if it exists. */
export function watchableDir(...segments: string[]): string {
  return path.resolve(...segments);
}
