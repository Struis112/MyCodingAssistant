// Web Process Supervisor
//
// Spawns `next start` for apps/web as a child of this API server process
// and respawns it with exponential backoff whenever it exits. The point is
// "always available": if the Next.js server crashes or is updated, this
// server brings it back without manual intervention.
//
// Off by default. Enabled when MCA_SUPERVISE_WEB=1 (also implicitly on
// in production via start-prod.ts). When off, this module is a no-op so
// it doesn't conflict with `npm run dev:web` during normal development.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { createConnection } from "node:net";

export type WebStatus =
  | { state: "disabled" }
  | { state: "stopped" }
  | { state: "starting"; startedAt: number; restarts: number }
  | { state: "running"; pid: number; port: number; startedAt: number; restarts: number }
  | {
      state: "backoff";
      reason: string;
      restarts: number;
      nextRestartAt: number;
    }
  | { state: "failed"; reason: string; restarts: number };

export interface WebSupervisorOptions {
  webDir: string;
  port: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRestarts?: number;
}

export class WebSupervisor extends EventEmitter {
  private opts: Required<WebSupervisorOptions>;
  private proc: ChildProcess | null = null;
  private status: WebStatus = { state: "stopped" };
  private restarts = 0;
  private shouldRun = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  constructor(opts: WebSupervisorOptions) {
    super();
    this.opts = {
      baseBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      maxRestarts: Number.POSITIVE_INFINITY,
      ...opts,
    };
  }

  getStatus(): WebStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.restarts = 0;

    // If something else (e.g. a forgotten `npm run dev:web`) is already on
    // the port, don't fight it — just refuse to supervise. The user can
    // free the port and call `restart()` later.
    if (await isPortInUse(this.opts.port)) {
      this.shouldRun = false;
      this.setStatus({
        state: "failed",
        reason: `Port ${this.opts.port} already in use. Stop the other process and POST /api/web/restart.`,
        restarts: 0,
      });
      console.warn(`[WebSupervisor] port ${this.opts.port} already in use, not supervising`);
      return;
    }

    this.spawnNow();
  }

  stop(): Promise<void> {
    this.shouldRun = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    return new Promise<void>((resolve) => {
      if (!this.proc) {
        this.setStatus({ state: "stopped" });
        resolve();
        return;
      }
      const child = this.proc;
      child.once("exit", () => {
        this.setStatus({ state: "stopped" });
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      // hard-kill if it doesn't go down in 5s
      setTimeout(() => {
        if (child.killed === false) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }, 5_000);
    });
  }

  async restart(): Promise<void> {
    const was = this.shouldRun;
    await this.stop();
    if (was) await this.start();
  }

  private spawnNow(): void {
    const { webDir, port } = this.opts;
    const nextBin = path.join(webDir, "node_modules", "next", "dist", "bin", "next");

    if (!existsSync(nextBin)) {
      this.shouldRun = false;
      this.setStatus({
        state: "failed",
        reason: `Cannot find Next.js binary at ${nextBin}. Run \`npm run build\` first.`,
        restarts: this.restarts,
      });
      return;
    }

    this.startedAt = Date.now();
    this.setStatus({ state: "starting", startedAt: this.startedAt, restarts: this.restarts });

    const proc = spawn(process.execPath, [nextBin, "start", "--port", String(port)], {
      cwd: webDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d) => process.stdout.write(`[web] ${d}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[web!] ${d}`));

    // We don't get a reliable "ready" signal from Next.js; mark running
    // optimistically once spawn fires, then if it crashes we'll catch exit.
    proc.on("spawn", () => {
      if (proc.pid !== undefined) {
        this.setStatus({
          state: "running",
          pid: proc.pid,
          port,
          startedAt: this.startedAt,
          restarts: this.restarts,
        });
      }
    });

    proc.on("exit", (code, signal) => {
      console.log(
        `[WebSupervisor] web exited code=${code} signal=${signal} (restarts=${this.restarts})`,
      );
      this.proc = null;
      if (!this.shouldRun) {
        this.setStatus({ state: "stopped" });
        return;
      }
      this.scheduleRestart(`exit code=${code} signal=${signal ?? "none"}`);
    });

    proc.on("error", (err) => {
      console.error("[WebSupervisor] spawn error:", err);
      // exit event will fire too with appropriate code
    });

    this.proc = proc;
  }

  private scheduleRestart(reason: string): void {
    this.restarts += 1;
    if (this.restarts > this.opts.maxRestarts) {
      this.setStatus({
        state: "failed",
        reason: `Exceeded max restarts (${this.opts.maxRestarts}): ${reason}`,
        restarts: this.restarts,
      });
      return;
    }
    const backoff = Math.min(
      this.opts.baseBackoffMs * 2 ** (this.restarts - 1),
      this.opts.maxBackoffMs,
    );
    const nextRestartAt = Date.now() + backoff;
    this.setStatus({ state: "backoff", reason, restarts: this.restarts, nextRestartAt });
    console.log(
      `[WebSupervisor] restart in ${backoff}ms (attempt ${this.restarts}, reason: ${reason})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shouldRun) this.spawnNow();
    }, backoff);
  }

  private setStatus(status: WebStatus): void {
    this.status = status;
    this.emit("status", status);
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (inUse: boolean) => {
      sock.destroy();
      resolve(inUse);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}
