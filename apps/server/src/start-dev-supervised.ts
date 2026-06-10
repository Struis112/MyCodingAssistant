// Dev-supervised entrypoint. Like start-prod.ts, but picks the web *dev*
// profile: the supervisor runs `next dev` (instant fast-refresh + browser
// auto-refresh) instead of `next start` against a production build.
//
// Use this when you want a single supervised process that also serves a live
// dev UI — edits to apps/web/src show up immediately, no rebuild loop, and the
// crash-restart / self-repair behaviour still applies.
//
// Run via `npm run dev:supervised` at the repo root. Don't also run
// `npm run dev:web` — the supervisor already owns the web dev server on the
// same port.
//
// ---- Pre-import guard (MCA_DEV_PRECHECK=1) ----
// Before we even attempt to load index.js, we typecheck the server workspace.
// If it fails (e.g. a save left a broken import on disk — see the 2026-06-10
// post-mortem), we log a focused diagnostic and exit non-zero WITHOUT pulling
// in the broken module. Under `tsx watch` that leaves the failing version
// parked until the next save, with a clean error in the logs — instead of a
// half-initialised module load that leaves the watchdog dead too.
//
// Opt-in (off by default) so a stale tsconfig/types issue can never block a
// developer who explicitly wants to run a known-broken server.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDevPrecheck } from "./services/dev-precheck.js";

process.env.MCA_SUPERVISE_WEB = "1";
process.env.MCA_WEB_DEV = "1";
process.env.NODE_ENV = "development";

if (process.env.MCA_DEV_PRECHECK === "1") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/start-dev-supervised.ts → src/  → server workspace = ..
  const serverDir = path.resolve(here, "..");
  const t0 = Date.now();
  const result = await runDevPrecheck({ serverDir });
  if (result.skipped) {
    console.warn(`[dev-precheck] ${result.logs} (${result.durationMs}ms)`);
  } else if (result.ok) {
    console.log(`[dev-precheck] ok (${result.durationMs}ms)`);
  } else {
    console.error(
      `[dev-precheck] FAILED after ${result.durationMs}ms — refusing to import server entry.\n` +
        `Fix the errors below and save again; tsx will retry.\n` +
        `------ tsc output ------\n${result.logs}\n------------------------`,
    );
    // Exit non-zero so NSSM/tsx see the failure. tsx watch will sit waiting
    // for the next file change, which is exactly the recovery behaviour we
    // want — fix on disk, save, re-evaluate.
    process.exit(1);
  }
  // Suppress unused-import warning if precheck branch is dead-coded later.
  void t0;
}

await import("./index.js");

// Mark this file as a module so top-level `await` is permitted under
// TypeScript's --isolatedModules / --module nodenext settings.
export {};
