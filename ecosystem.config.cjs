// PM2 process definitions — scaffolded ahead of the process-manager refactor.
//
// STATUS: this file exists so PM2 can manage the same processes NSSM +
// ServiceSupervisor manage today. It is NOT yet the active supervisor — the
// Windows NSSM services still own the running system. Bring PM2 up only when
// the NSSM services are stopped (they bind the same ports).
//
// Process model under PM2 (one OS process each, PM2 supervises all three):
//   mca-server   — the API + WebSocket server (dist/index.js).
//                  NOTE: deliberately NOT start-prod.js. start-prod sets
//                  MCA_SUPERVISE_WEB=1 so the API spawns/supervises Next
//                  itself; under PM2, PM2 owns the web process, so internal
//                  web supervision must stay OFF or the two fight.
//   mca-web      — the Next.js server. Dev (HMR) by default because the prod
//                  `next build` is currently blocked on this machine; flip to
//                  prod by setting MCA_WEB_DEV unset/0 once that's fixed.
//   mca-deployer — the self-healing deploy controller (dist/start-deployer.js).
//
// Restart policy mirrors the project standard (AGENTS.md): retry ~once per
// minute, cap at 50, then PM2 parks the process (stopped) for a manual start.

const path = require("node:path");

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, "apps", "web");
const LOGS = path.join(ROOT, "logs");

// Match the codebase convention: MCA_WEB_DEV=1 => Next dev (HMR). Default dev,
// since the production build is currently broken (documented separately).
const WEB_DEV = process.env.MCA_WEB_DEV !== "0";

// Ports are overridable so a cutover smoke-test can run PM2 on alternate ports
// (e.g. MCA_API_PORT=7651 MCA_WEB_PORT=7652) without colliding with the live
// NSSM services on 7641/7642. Defaults match the live ports.
const API_PORT = process.env.MCA_API_PORT || "7641";
const WEB_PORT = process.env.MCA_WEB_PORT || "7642";

// Point PM2 at Next's bin JS directly (most reliable cross-platform — avoids
// npm-wrapper quirks). require.resolve finds it whether npm hoisted `next` to
// the repo root or kept it under apps/web/node_modules.
const NEXT_BIN = require.resolve("next/dist/bin/next", { paths: [WEB_DIR] });

/** Shared options applied to every app (self-repair defaults + logging). */
const common = (name) => ({
  instances: 1, // stateful WebSocket server — never cluster.
  exec_mode: "fork",
  autorestart: true,
  max_restarts: 50, // DEFAULT_MAX_RESTARTS
  restart_delay: 60_000, // DEFAULT_RESTART_INTERVAL_MS (retry once per minute)
  min_uptime: "30s", // crashes faster than this count toward max_restarts
  kill_timeout: 5_000, // give a graceful shutdown a moment before SIGKILL
  // Builds are a separate step (tsc / next build); PM2 watch can't rebuild, so
  // hot-reload stays owned by the dev watchers / the refactor's restart hook.
  watch: false,
  time: true, // timestamp every log line
  merge_logs: true,
  out_file: path.join(LOGS, `pm2-${name}.out.log`),
  error_file: path.join(LOGS, `pm2-${name}.err.log`),
});

module.exports = {
  apps: [
    {
      ...common("server"),
      name: "mca-server",
      cwd: ROOT,
      script: path.join(ROOT, "apps", "server", "dist", "index.js"),
      env: {
        NODE_ENV: "production",
        PORT: API_PORT,
        HOST: "0.0.0.0",
        // MCA_SUPERVISE_WEB intentionally unset — PM2 owns the web process.
      },
    },
    {
      ...common("web"),
      name: "mca-web",
      cwd: WEB_DIR,
      script: NEXT_BIN,
      args: WEB_DEV ? `dev -p ${WEB_PORT}` : `start -p ${WEB_PORT}`,
      env: {
        NODE_ENV: WEB_DEV ? "development" : "production",
        // Keep dev (.next) and prod (.next-prod) build outputs separate so a
        // prod build can never corrupt a running dev server (see next.config).
        NEXT_DIST_DIR: WEB_DEV ? ".next" : ".next-prod",
      },
    },
    {
      ...common("deployer"),
      name: "mca-deployer",
      cwd: ROOT,
      script: path.join(ROOT, "apps", "server", "dist", "start-deployer.js"),
      env: {
        NODE_ENV: "production",
        // Deployer reads REPO_DIR / LIVE_REF / STAGING_REF / MCA_DEPLOY_* from
        // the environment with sensible defaults; add overrides here as needed.
      },
    },
  ],
};
