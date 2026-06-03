// Service Registry — the single inventory of every supervised service.
//
// The "Services" screen and /api/services read from here. Each entry is a
// ServiceSupervisor following the project standards (hot-reload + self-repair,
// see AGENTS.md). A registry can also hold "self-reported" services: things
// like the API server itself which can't supervise their own process but
// should still appear in the inventory.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import {
  ServiceSupervisor,
  type LogLine,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-supervisor.js";

/** A service the registry reports on but does not spawn (e.g. this process). */
export interface SelfReportedService {
  name: string;
  description: string;
  port?: number;
  getStatus: () => ServiceStatus;
  getLogs?: () => LogLine[];
}

export class ServiceRegistry extends EventEmitter {
  private supervised = new Map<string, ServiceSupervisor>();
  private selfReported = new Map<string, SelfReportedService>();

  register(service: ServiceSupervisor): ServiceSupervisor {
    this.supervised.set(service.name, service);
    service.on("status", () => this.emit("status", this.list()));
    return service;
  }

  registerSelfReported(service: SelfReportedService): void {
    this.selfReported.set(service.name, service);
  }

  has(name: string): boolean {
    return this.supervised.has(name) || this.selfReported.has(name);
  }

  list(): ServiceStatus[] {
    return [
      ...[...this.supervised.values()].map((s) => s.getStatus()),
      ...[...this.selfReported.values()].map((s) => s.getStatus()),
    ];
  }

  getLogs(name: string, limit?: number): LogLine[] {
    const sup = this.supervised.get(name);
    if (sup) return sup.getLogs(limit);
    const self = this.selfReported.get(name);
    return self?.getLogs?.() ?? [];
  }

  /** Restart a supervised service. Self-reported services can't be restarted. */
  async restart(name: string): Promise<{ ok: boolean; reason?: string }> {
    return this.control(name, "restart");
  }

  /** Start a supervised service. Self-reported services can't be started here. */
  async start(name: string): Promise<{ ok: boolean; reason?: string }> {
    return this.control(name, "start");
  }

  /** Stop a supervised service. Self-reported services can't be stopped here. */
  async stop(name: string): Promise<{ ok: boolean; reason?: string }> {
    return this.control(name, "stop");
  }

  /** Shared lifecycle control for the three supervised actions. */
  private async control(
    name: string,
    action: "start" | "stop" | "restart",
  ): Promise<{ ok: boolean; reason?: string }> {
    const sup = this.supervised.get(name);
    if (sup) {
      await sup[action]();
      return { ok: true };
    }
    if (this.selfReported.has(name)) {
      const verb = action === "stop" ? "stopped" : action === "start" ? "started" : "restarted";
      return { ok: false, reason: `${name} is self-managed and cannot be ${verb} from here.` };
    }
    return { ok: false, reason: `Unknown service: ${name}` };
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.supervised.values()].map((s) => s.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.supervised.values()].map((s) => s.stop()));
  }
}

// ---------------------------------------------------------------------------
// Web (Next.js) service factory
// ---------------------------------------------------------------------------

/**
 * Locate the `next` binary. npm workspaces hoists shared deps to the repo
 * root, so it's usually at `<repoRoot>/node_modules/next/...`. Resolve from
 * the web package first (walks up the tree), then fall back to the per-package
 * path for non-workspace installs.
 */
function findNextBinary(webDir: string): string | null {
  try {
    const requireFromWeb = createRequire(path.join(webDir, "package.json"));
    const resolved = requireFromWeb.resolve("next/dist/bin/next");
    if (existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }
  const legacy = path.join(webDir, "node_modules", "next", "dist", "bin", "next");
  return existsSync(legacy) ? legacy : null;
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

/**
 * Locate the TypeScript compiler (`tsc`) for the validation gate. Workspaces
 * hoist `typescript` to the repo root, so resolve it from the web package.
 */
function findTscBinary(webDir: string): string | null {
  try {
    const req = createRequire(path.join(webDir, "package.json"));
    const resolved = req.resolve("typescript/lib/tsc.js");
    if (existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Validation gate: typecheck the web workspace (`tsc --noEmit`). Fast, and it
 * catches the most common AI-authored breakage (type errors) BEFORE we run the
 * expensive `next build` + restart, so a bad change never reaches the running
 * server. Captures combined output for the repair loop.
 */
function runTypecheck(webDir: string, tscBin: string): Promise<{ ok: boolean; logs: string }> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(
      process.execPath,
      [tscBin, "--noEmit", "-p", path.join(webDir, "tsconfig.json")],
      {
        cwd: webDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    proc.stdout?.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      out += d.toString();
    });
    proc.on("exit", (code) => resolve({ ok: code === 0, logs: out.trim() }));
    proc.on("error", (err) => resolve({ ok: false, logs: String(err) }));
  });
}

/** Run `next build` in webDir, resolving on success and rejecting on failure. */
function runNextBuild(webDir: string, nextBin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [nextBin, "build"], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => process.stdout.write(`[web:build] ${d}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[web:build!] ${d}`));
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`next build exited with code ${code}`)),
    );
    proc.on("error", reject);
  });
}

export interface WebServiceOptions {
  webDir: string;
  port: number;
  /** Extra source dirs to watch for hot-reload (besides apps/web/src). */
  extraWatchPaths?: string[];
  /** Enable hot-reload (watch + rebuild + restart). Default true. Ignored in dev mode. */
  hotReload?: boolean;
  /**
   * Dev profile: run `next dev` instead of `next start`. Next's own
   * fast-refresh serves edits instantly (no rebuild + restart loop, and the
   * browser auto-refreshes), so we skip the build-related preflight/watch.
   * Crash-restart + self-repair still apply.
   */
  dev?: boolean;
}

/**
 * Build the ServiceSpec for the Next.js web app. Two profiles:
 *
 *   prod (default):
 *     - spawns `next start` against the production build
 *     - hot-reload: watches src; on change rebuilds with `next build` + restarts
 *     - self-repair: if startup fails because the build is missing/stale, builds it
 *
 *   dev (opts.dev = true):
 *     - spawns `next dev` — instant fast-refresh + browser auto-refresh, no
 *       rebuild loop. No build preflight/watch; crash-restart still applies.
 */
export function createWebService(opts: WebServiceOptions): ServiceSupervisor {
  const { webDir, port } = opts;
  const dev = opts.dev ?? false;
  const hotReload = opts.hotReload ?? true;
  const nextBuildDir = path.join(webDir, ".next");

  if (dev) {
    const devSpec: ServiceSpec = {
      name: "web",
      description: "Next.js web UI (dev / fast-refresh, port " + port + ")",
      mode: "dev",
      port,
      resolveCommand: () => {
        const nextBin = findNextBinary(webDir);
        if (!nextBin) throw new Error(`Next.js binary not found near ${webDir} — run npm install`);
        return {
          command: process.execPath,
          args: [nextBin, "dev", "--port", String(port)],
          cwd: webDir,
          env: {
            ...process.env,
            NODE_ENV: "development",
            PORT: String(port),
            NEXT_TELEMETRY_DISABLED: "1",
          },
        };
      },
      preflight: async () => {
        if (!findNextBinary(webDir)) {
          return {
            ok: false,
            reason: `Next.js binary not found near ${webDir}. Run \`npm install\`.`,
          };
        }
        if (await isPortInUse(port)) {
          return {
            ok: false,
            reason: `Port ${port} already in use. Stop the other process, then restart this service.`,
          };
        }
        return { ok: true };
      },
      // No watch/rebuild: `next dev` handles fast-refresh itself.
    };
    return new ServiceSupervisor(devSpec);
  }

  const spec: ServiceSpec = {
    name: "web",
    description: "Next.js web UI (production build, port " + port + ")",
    mode: "prod",
    port,
    resolveCommand: () => {
      const nextBin = findNextBinary(webDir);
      if (!nextBin) throw new Error(`Next.js binary not found near ${webDir} — run npm install`);
      return {
        command: process.execPath,
        args: [nextBin, "start", "--port", String(port)],
        cwd: webDir,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(port),
          NEXT_TELEMETRY_DISABLED: "1",
        },
      };
    },
    preflight: async () => {
      if (!findNextBinary(webDir)) {
        return {
          ok: false,
          reason: `Next.js binary not found near ${webDir}. Run \`npm install\` then \`npm run build\`.`,
        };
      }
      if (!existsSync(nextBuildDir)) {
        // Self-heal the common "never built" case rather than failing.
        const nextBin = findNextBinary(webDir)!;
        try {
          await runNextBuild(webDir, nextBin);
        } catch (err) {
          return { ok: false, reason: `Initial build failed: ${String(err)}` };
        }
      }
      if (await isPortInUse(port)) {
        return {
          ok: false,
          reason: `Port ${port} already in use. Stop the other process, then restart this service.`,
        };
      }
      return { ok: true };
    },
    repair: async (logs) => {
      // Known failure mode: a stale/missing .next build after code changes.
      const recent = logs
        .slice(-30)
        .map((l) => l.text)
        .join("\n");
      const looksLikeBuildIssue =
        !existsSync(nextBuildDir) ||
        /ENOENT|Could not find|Cannot find module|build.*not found|\.next/i.test(recent);
      if (!looksLikeBuildIssue) return { repaired: false };
      const nextBin = findNextBinary(webDir);
      if (!nextBin) return { repaired: false, note: "Next.js binary missing; cannot rebuild." };
      try {
        await runNextBuild(webDir, nextBin);
        return { repaired: true, note: "Rebuilt .next after detecting a build-related crash." };
      } catch (err) {
        return { repaired: false, note: `Auto-rebuild failed: ${String(err)}` };
      }
    },
    // Deploy contract (Phase 1 — docs/architecture/self-healing-deploy.md):
    // validate (typecheck) BEFORE activating, and a readiness probe after.
    sources: [path.join(webDir, "src"), ...(opts.extraWatchPaths ?? [])].filter((p) =>
      existsSync(p),
    ),
    validate: async () => {
      const tsc = findTscBinary(webDir);
      if (!tsc) return { ok: true, logs: "typecheck skipped (tsc not found)" };
      return runTypecheck(webDir, tsc);
    },
    // Ready = something is listening on the web port (i.e. `next start` is up).
    readiness: async () => isPortInUse(port),
    watch: hotReload
      ? {
          paths: [path.join(webDir, "src"), ...(opts.extraWatchPaths ?? [])].filter((p) =>
            existsSync(p),
          ),
          rebuild: async () => {
            const nextBin = findNextBinary(webDir);
            if (!nextBin) throw new Error("Next.js binary not found");
            await runNextBuild(webDir, nextBin);
          },
          debounceMs: 600,
        }
      : undefined,
  };

  return new ServiceSupervisor(spec);
}
