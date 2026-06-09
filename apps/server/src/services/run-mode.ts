// Run-mode helper (dev/HMR vs hybrid vs prod)
//
// Three ways to run the stack (see README "Run modes"):
//
//   dev    — watch/HMR: the service runs `tsx watch start-dev-supervised.ts`,
//            giving `next dev` Fast Refresh for the web UI AND auto-restart for
//            the server. Most immediate, but a server-source edit restarts the
//            API mid-request (so the assistant editing server code can cut off
//            its own reply).
//   hybrid — stable server + web HMR: the service runs the BUILT server
//            (`node dist/start-dev-supervised.js`, still `next dev` for web).
//            The server does NOT auto-restart, so editing server code never
//            interrupts a turn; pick up server changes with "Rebuild & restart".
//   prod   — production build: `node dist/start-prod.js` (`next start`).
//
// The switch only changes the NSSM `AppParameters` (which entry the service
// runs); each entry sets its own env. `currentRunMode()` reflects the process.

import path from "node:path";

export type RunMode = "dev" | "hybrid" | "prod";

/**
 * The mode the current process is running in. `dev` and `hybrid` both set
 * MCA_WEB_DEV=1 (web Fast Refresh); they differ in whether the SERVER runs
 * under `tsx watch` (dev) or plain node from dist (hybrid). Env/argv are
 * injectable for testing.
 */
export function currentRunMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): RunMode {
  if (env.MCA_WEB_DEV !== "1") return "prod";
  const a = argv.join(" ").toLowerCase();
  const watched = a.includes("tsx") && a.includes("watch");
  return watched ? "dev" : "hybrid";
}

/**
 * The NSSM `AppParameters` string (arguments to node.exe) for a given mode.
 * Paths are quoted so a future repo path with spaces still works.
 */
export function appParametersFor(mode: RunMode, repoRoot: string): string {
  const q = (p: string) => `"${p}"`;
  if (mode === "prod") {
    return q(path.join(repoRoot, "apps", "server", "dist", "start-prod.js"));
  }
  if (mode === "hybrid") {
    return q(path.join(repoRoot, "apps", "server", "dist", "start-dev-supervised.js"));
  }
  const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(repoRoot, "apps", "server", "src", "start-dev-supervised.ts");
  return `${q(tsx)} watch ${q(entry)}`;
}

/** Which build a mode needs before its entry exists/refreshes. */
export function buildTargetFor(mode: RunMode): "none" | "server" | "full" {
  if (mode === "dev") return "none"; // runs from source via tsx
  if (mode === "hybrid") return "server"; // built server, web uses next dev
  return "full"; // prod: built server + web
}
