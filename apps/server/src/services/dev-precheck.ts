// Dev-side pre-flight typecheck.
//
// Closes the failure mode that bit us in the 2026-06-10 incident: an unstaged
// edit to `apps/server/src/index.ts` referenced a module that didn't exist on
// disk. `tsx watch` happily re-executed the file, the top-level `import` threw
// at module load (`ERR_MODULE_NOT_FOUND`), the process exited, and tsx sat
// waiting for the next file change. The server stayed dead and the
// in-process HealthWatchdog never ran (it lives *inside* the dead process).
//
// This module is the cheap, dev-only guard: BEFORE we even attempt to import
// the server entry, run `tsc --noEmit` over the server workspace. A failure
// means "do not swap the running version onto this broken code." The current
// process either:
//   (a) refuses to import the entry (when we're the watch-safe restarter, so
//       the previous-good server keeps serving), or
//   (b) exits with a clear, focused error message (when we're the cold-start
//       supervised entry, so the operator and the logs both see *why*).
//
// Either way, the error surface is a single tsc diagnostic instead of a
// half-initialised module load — which is much easier for both humans and
// the AI repair loop to consume.
//
// Pure shell-out + injectable spawner: no fs side effects, fully unit-testable
// with a fake runner.

import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

export interface DevPrecheckResult {
  ok: boolean;
  /** Combined stdout+stderr from tsc (truncated to ~8 KB). */
  logs: string;
  /** "skipped" when tsc couldn't be located — treated as ok:true. */
  skipped?: boolean;
  /** Wall-clock duration of the precheck (ms). */
  durationMs: number;
}

export interface DevPrecheckOptions {
  /** Directory of the server workspace (contains tsconfig.json). */
  serverDir: string;
  /**
   * Injectable runner — defaults to spawning `node <tsc> --noEmit -p tsconfig.json`.
   * Tests pass a fake to assert behaviour deterministically.
   */
  run?: (args: { tscBin: string; tsconfig: string; cwd: string }) => Promise<{
    code: number;
    output: string;
  }>;
  /** Injectable tsc resolver — exists so tests can simulate "tsc not found". */
  findTsc?: (serverDir: string) => string | null;
  /** Injectable tsconfig existence check (tests). Default: real fs check. */
  tsconfigExists?: (tsconfigPath: string) => boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

const MAX_LOG_BYTES = 8 * 1024;

/**
 * Resolve `typescript/lib/tsc.js` from the server workspace (npm workspaces
 * hoist it to the repo root). Returns null if the package is missing —
 * `runDevPrecheck` treats that as "skip" rather than fail.
 */
export function findServerTsc(serverDir: string): string | null {
  try {
    const req = createRequire(path.join(serverDir, "package.json"));
    const resolved = req.resolve("typescript/lib/tsc.js");
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** Default runner: spawn node tsc, capture combined output, resolve on exit. */
function defaultRun(args: {
  tscBin: string;
  tsconfig: string;
  cwd: string;
}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const proc = spawn(process.execPath, [args.tscBin, "--noEmit", "-p", args.tsconfig], {
      cwd: args.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => {
      output += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      output += d.toString();
    });
    proc.on("exit", (code) => resolve({ code: code ?? 1, output }));
    proc.on("error", (err) => resolve({ code: 1, output: String(err) }));
  });
}

/**
 * Typecheck the server workspace. Returns ok:true (with `skipped: true`) when
 * tsc isn't installed — we don't want this guard to block a fresh checkout
 * before `npm install`. Returns ok:false with focused diagnostics on failure.
 */
export async function runDevPrecheck(opts: DevPrecheckOptions): Promise<DevPrecheckResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const findTsc = opts.findTsc ?? findServerTsc;
  const tscBin = findTsc(opts.serverDir);
  if (!tscBin) {
    return {
      ok: true,
      logs: "[dev-precheck] tsc not found in node_modules — skipped",
      skipped: true,
      durationMs: now() - t0,
    };
  }
  const tsconfig = path.join(opts.serverDir, "tsconfig.json");
  const tsconfigExists = opts.tsconfigExists ?? existsSync;
  if (!tsconfigExists(tsconfig)) {
    return {
      ok: true,
      logs: `[dev-precheck] no tsconfig at ${tsconfig} — skipped`,
      skipped: true,
      durationMs: now() - t0,
    };
  }
  const run = opts.run ?? defaultRun;
  const { code, output } = await run({ tscBin, tsconfig, cwd: opts.serverDir });
  // Cap output. tsc on a clean run is silent; on failure it's typically a
  // handful of lines but a broken tsconfig can spew. Truncate from the head
  // so the last (most actionable) errors are always visible.
  const logs = output.length > MAX_LOG_BYTES ? output.slice(output.length - MAX_LOG_BYTES) : output;
  return { ok: code === 0, logs: logs.trim(), durationMs: now() - t0 };
}
