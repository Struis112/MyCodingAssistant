// MyCodingAssistant Server - Entry point
// Integrates one or more coding-agent harnesses via WebSocket + REST API.
// Today there's a single connector (Pi SDK); future harnesses (Claude Code,
// Opencode Go) register themselves the same way.

import express from "express";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectorRegistry } from "./connectors/registry.js";
import { createPiConnector } from "./connectors/pi/index.js";
import { ServiceRegistry, createWebService } from "./services/service-registry.js";
import { HealthWatchdog } from "./services/health-watchdog.js";
import {
  appParametersFor,
  buildTargetFor,
  currentRunMode,
  type RunMode,
} from "./services/run-mode.js";
import type { ServiceStatus } from "./services/service-supervisor.js";
import { registerApiRoutes } from "./api/routes.js";
import { registerWebSocketHandlers } from "./websocket/handlers.js";

// Resolve paths relative to the entry script, not the cwd. The previous
// `process.cwd()`-based default for MCA_WEB_DIR broke when starting the
// service from a different directory (e.g. C:\Windows\System32 when a
// Windows Service launches us): it produced `<cwd>/../web`, which is
// nonsense unless cwd happens to be apps/server.
//
// `import.meta.url` points at this file:
//   dev:  apps/server/src/index.ts        → ../../web = apps/web
//   prod: apps/server/dist/index.js       → ../../web = apps/web
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Project root the agent operates inside. Used by:
//   - PiSessionManager.cwd  (so the SDK puts auth/sessions in the right place)
//   - /api/files/*           (so revert/read/save are confined to the project)
//
// Anchored to the entry script by default, so a service launched from
// C:\Windows\System32 still finds the repo correctly. Override with
// MCA_PROJECT_ROOT for setups where the server lives outside the repo.
const PROJECT_ROOT = process.env.MCA_PROJECT_ROOT
  ? path.resolve(process.env.MCA_PROJECT_ROOT)
  : path.resolve(HERE, "..", "..", "..");

const PORT = parseInt(process.env.PORT || "7641", 10);
const HOST = process.env.HOST || "0.0.0.0";
// CORS: by default REFLECT the request origin so the app works whether you open
// it on localhost OR over the LAN (http://<lan-ip>:7642). This is a local,
// single-user tool on a trusted network, so reflecting is the pragmatic choice.
// NOTE: we intentionally do NOT use MCA_WEB_ORIGIN here — the installer sets it
// to http://localhost:7642, which would (wrongly) lock out LAN devices. To
// restrict CORS explicitly, set MCA_CORS_ORIGIN (comma-separated origins).
const corsOrigin: cors.CorsOptions["origin"] = process.env.MCA_CORS_ORIGIN
  ? process.env.MCA_CORS_ORIGIN.split(",").map((s) => s.trim())
  : true;

// Express app
const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// HTTP server
const httpServer = createServer(app);

// WebSocket server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
  // Make brief outages (e.g. a deploy restart) transparent: socket.io restores
  // the client's session and replays events missed during the disconnect window.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// Connector registry. The first connector registered becomes the default,
// so today every chat:* event still resolves to the Pi SDK manager exactly
// as before.
const connectors = new ConnectorRegistry();
connectors.register(createPiConnector(PROJECT_ROOT));
const piSessionManager = connectors.getDefaultManager();

// Optional: keep the Next.js web server alive across crashes / updates.
// Off by default so `npm run dev:server` doesn't fight `npm run dev:web`.
// `start-prod.ts` flips MCA_SUPERVISE_WEB=1 for `npm run start`.
const webPort = parseInt(process.env.WEB_PORT || "7642", 10);
const webDir = process.env.MCA_WEB_DIR || path.resolve(HERE, "..", "..", "web");

// Service registry — the single inventory behind the "Services" screen.
// Every supervised service follows the project standards: hot-reload
// (watch + rebuild + restart) and self-repair (retry once/min, max 50).
const services = new ServiceRegistry();

// The API server reports on itself so it shows up in the inventory, even
// though it can't supervise its own process. Restart is handled by the OS
// service / `tsx watch` in dev.
const serverStartedAt = Date.now();
services.registerSelfReported({
  name: "api",
  description: `API + WebSocket server (port ${PORT})`,
  port: PORT,
  getStatus: (): ServiceStatus => ({
    name: "api",
    description: `API + WebSocket server (port ${PORT})`,
    state: "running",
    pid: process.pid,
    port: PORT,
    startedAt: serverStartedAt,
    uptimeMs: Math.round(process.uptime() * 1000),
    restarts: 0,
    maxRestarts: 0,
    hotReloadEnabled: process.env.NODE_ENV !== "production",
  }),
});

// The web UI is supervised when MCA_SUPERVISE_WEB=1 (implicit in prod via
// start-prod.ts). Off in dev so it doesn't fight `npm run dev:web`.
//
// MCA_WEB_DEV=1 picks the dev profile: the supervisor runs `next dev` instead
// of `next start`, giving instant fast-refresh + browser auto-refresh (no
// rebuild loop). Handy when you want supervision *and* a live dev UI.
const webDevMode = process.env.MCA_WEB_DEV === "1";
if (process.env.MCA_SUPERVISE_WEB === "1") {
  services.register(createWebService({ webDir, port: webPort, dev: webDevMode }));
}

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: services.list(),
  });
});

// ----- Account usage (Anthropic 5-hour + weekly limits) -----
// The upstream endpoint is tightly rate-limited (empirically ~3 requests per
// rolling 5-minute window; a 429 returns `retry-after: 300`). So we:
//   - cache the last GOOD value and serve it through any failure (the header
//     never flips to "—" on a transient blip), and
//   - only re-fetch after a long TTL, and back off for `retry-after` on a 429.
// Net upstream rate: at most ~1 request / 5 min — comfortably under the limit.
let usageCache: {
  at: number;
  data: { fiveHourPct: number | null; weeklyPct: number | null };
} | null = null;
let usageCooldownUntil = 0;
const USAGE_TTL_MS = 5 * 60_000;
app.get("/api/usage", async (req, res) => {
  const debug = req.query.debug === "1";
  if (!piSessionManager.getAccountUsage) {
    res.json({ fiveHourPct: null, weeklyPct: null });
    return;
  }
  if (debug) {
    res.json(await piSessionManager.getAccountUsage({ debug: true }));
    return;
  }
  const now = Date.now();
  // Serve the cached value while it's fresh OR while we're backing off a 429.
  if (usageCache && (now - usageCache.at < USAGE_TTL_MS || now < usageCooldownUntil)) {
    res.json(usageCache.data);
    return;
  }
  try {
    const data = await piSessionManager.getAccountUsage();
    if (data.rateLimited) {
      usageCooldownUntil = now + (data.retryAfterMs ?? 5 * 60_000);
      res.json(usageCache?.data ?? data);
      return;
    }
    const fresh = data.fiveHourPct !== null || data.weeklyPct !== null;
    if (fresh) {
      usageCache = { at: now, data };
      res.json(data);
    } else {
      res.json(usageCache?.data ?? data);
    }
  } catch (err) {
    if (usageCache) res.json(usageCache.data);
    else res.json({ fiveHourPct: null, weeklyPct: null, error: String(err) });
  }
});

// ----- Run mode (dev/HMR ↔ prod build) -----
// Switching only rewrites the NSSM AppParameters (which entry the service runs)
// and bounces the service; each entry sets its own env. Requires the bundled
// NSSM and that the service runs as the repo owner (Administrator).
const SERVICE_NAME = process.env.MCA_SERVICE_NAME || "MyCodingAssistant";
const NSSM_PATH = path.join(PROJECT_ROOT, "tools", "nssm", "nssm.exe");

function runCmd(
  cmd: string,
  args: string[],
  useShell: boolean,
): Promise<{ ok: boolean; logs: string }> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(cmd, args, { cwd: PROJECT_ROOT, shell: useShell });
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", (d) => (out += d.toString()));
    proc.on("exit", (code) => resolve({ ok: code === 0, logs: out }));
    proc.on("error", (err) => resolve({ ok: false, logs: String(err) }));
  });
}

app.get("/api/runmode", (_req, res) => {
  res.json({ mode: currentRunMode(), canSwitch: existsSync(NSSM_PATH) });
});

app.post("/api/runmode", async (req, res) => {
  const mode = req.body?.mode as RunMode;
  if (mode !== "dev" && mode !== "hybrid" && mode !== "prod") {
    res.status(400).json({ ok: false, error: "mode must be 'dev', 'hybrid', or 'prod'" });
    return;
  }
  if (!existsSync(NSSM_PATH)) {
    res.status(400).json({ ok: false, error: "This service isn't managed by the bundled NSSM." });
    return;
  }
  if (mode === currentRunMode()) {
    res.json({ ok: true, mode, restarting: false, note: "already in this mode" });
    return;
  }
  try {
    // Built entries need an up-to-date build first: hybrid runs the built server
    // (server-only build), prod runs the built server + web (full build), dev
    // runs from source (no build).
    const target = buildTargetFor(mode);
    if (target !== "none") {
      const args =
        target === "full" ? ["run", "build"] : ["run", "build", "--workspace=@mca/server"];
      console.log(`[runmode] building (${target}) for ${mode}…`);
      const built = await runCmd("npm", args, process.platform === "win32");
      if (!built.ok) {
        res.status(500).json({ ok: false, error: `build failed:\n${built.logs.slice(-2000)}` });
        return;
      }
    }
    const set = await runCmd(
      NSSM_PATH,
      ["set", SERVICE_NAME, "AppParameters", appParametersFor(mode, PROJECT_ROOT)],
      false,
    );
    if (!set.ok) {
      res.status(500).json({ ok: false, error: `nssm set failed:\n${set.logs}` });
      return;
    }
    res.json({ ok: true, mode, restarting: true });
    // Bounce the service via a DETACHED nssm restart so it survives its own
    // process tree being killed, and relaunches with the new AppParameters.
    setTimeout(() => {
      try {
        const child = spawn(NSSM_PATH, ["restart", SERVICE_NAME], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch (err) {
        console.error("[runmode] restart failed", err);
      }
    }, 800);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ----- Services inventory + control -----
app.get("/api/services", (_req, res) => {
  res.json(services.list());
});

app.get("/api/services/:name/logs", (req, res) => {
  if (!services.has(req.params.name)) {
    res.status(404).json({ error: `Unknown service: ${req.params.name}` });
    return;
  }
  res.json(services.getLogs(req.params.name));
});

// Lifecycle control: start | stop | restart. One handler, three verbs.
for (const action of ["start", "stop", "restart"] as const) {
  app.post(`/api/services/:name/${action}`, async (req, res) => {
    if (!services.has(req.params.name)) {
      res.status(404).json({ success: false, error: `Unknown service: ${req.params.name}` });
      return;
    }
    const result = await services[action](req.params.name);
    if (!result.ok) {
      res.status(400).json({ success: false, error: result.reason });
      return;
    }
    res.json({ success: true, status: services.list() });
  });
}

// Backwards-compatible web-only aliases.
app.get("/api/web/status", (_req, res) => {
  const web = services.list().find((s) => s.name === "web");
  res.json(web ?? { state: "disabled" });
});

app.post("/api/web/restart", async (_req, res) => {
  const result = await services.restart("web");
  if (!result.ok) {
    res.status(400).json({ error: result.reason });
    return;
  }
  res.json({ success: true, status: services.list() });
});

registerApiRoutes(app, piSessionManager, { cwd: PROJECT_ROOT });
// Auto-reload-on-redeploy: report the current frontend build id on every
// (re)connect. The client remembers the id it first saw and reloads itself
// once when a newer one appears (i.e. the web app was redeployed) — so a deploy
// updates open tabs with no manual refresh. Returns null in dev / before a
// build, where we don't want to force reloads.
function getWebBuildId(): string | null {
  try {
    return readFileSync(path.join(webDir, ".next", "BUILD_ID"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
// Shared, cross-device tab list (which conversations are open + their order).
// Persisted so it survives restarts and broadcast so every device shows the
// same tabs. Only file-backed conversations are shared; brand-new empty tabs
// stay local to a device until their first message creates a session file.
type SharedTab = { sessionFile: string; name: string | null };
const SHARED_TABS_PATH = path.join(PROJECT_ROOT, "logs", "mca-tabs.json");
let sharedTabs: SharedTab[] = (() => {
  try {
    const raw = JSON.parse(readFileSync(SHARED_TABS_PATH, "utf8"));
    return Array.isArray(raw) ? (raw as SharedTab[]) : [];
  } catch {
    return [];
  }
})();
function saveSharedTabs(): void {
  try {
    mkdirSync(path.dirname(SHARED_TABS_PATH), { recursive: true });
    writeFileSync(SHARED_TABS_PATH, JSON.stringify(sharedTabs));
  } catch (err) {
    console.error("[tabs] could not persist shared tabs:", err);
  }
}

io.on("connection", (socket) => {
  socket.emit("app:version", { buildId: getWebBuildId() });
  // Send the current shared tab list on connect.
  socket.emit("tabs:sync", { tabs: sharedTabs });
  socket.on("tabs:get", () => socket.emit("tabs:sync", { tabs: sharedTabs }));
  socket.on("tabs:set", (data: { tabs?: SharedTab[] }) => {
    if (!Array.isArray(data?.tabs)) return;
    sharedTabs = data.tabs
      .filter((t) => t && typeof t.sessionFile === "string")
      .map((t) => ({ sessionFile: t.sessionFile, name: t.name ?? null }));
    saveSharedTabs();
    // Broadcast to OTHER devices (the sender already has this state).
    socket.broadcast.emit("tabs:sync", { tabs: sharedTabs });
  });
});

registerWebSocketHandlers(io, piSessionManager);

// Forward service-status changes to all connected clients so the Services
// screen updates live.
services.on("status", (list: ServiceStatus[]) => {
  io.emit("services:status", list);
});

// Health watchdog: when a service has FAILED (its own self-repair already gave
// up), surface a structured repair request with the logs. This is the hook the
// AI repair loop consumes ("read the logs, fix it"); for now we log it and emit
// a signal clients can show. Re-evaluates on every status change + periodically.
const watchdog = new HealthWatchdog({
  getStatuses: () => services.list(),
  getLogs: (name) => services.getLogs(name, 50),
  onRepairNeeded: (req) => {
    console.warn(
      `[watchdog] '${req.service}' is ${req.state} — repair needed (unhealthy since ${new Date(req.since).toISOString()})`,
    );
    io.emit("service:repairNeeded", req);
  },
});
services.on("status", () => watchdog.check());
watchdog.start();

httpServer.listen(PORT, HOST, () => {
  console.log(`[MCA Server] Running on http://${HOST}:${PORT}`);
  console.log("[MCA Server] WebSocket ready for frontend connections");
  if (process.env.MCA_SUPERVISE_WEB === "1") {
    console.log(
      webDevMode
        ? `[MCA Server] Web service supervised — dev / fast-refresh on port ${webPort}`
        : `[MCA Server] Web service supervised — hot-reload + self-repair on port ${webPort}`,
    );
    void services.startAll();
  } else {
    console.log("[MCA Server] Web supervisor disabled (set MCA_SUPERVISE_WEB=1 to enable)");
  }
});

let shuttingDown = false;
async function shutdown() {
  // The service manager (NSSM) may deliver the stop signal more than once;
  // make shutdown idempotent so we don't run teardown twice.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[MCA Server] Shutting down...");

  // Guaranteed exit: a non-unref'd timer so the process always terminates
  // quickly even if a close hangs. Keeping this short is what lets the service
  // manager's stop -> start cycle complete (a slow stop makes Restart-Service
  // give up before issuing the start).
  const hardExit = setTimeout(() => {
    console.log("[MCA Server] Forced exit (graceful close timed out)");
    process.exit(0);
  }, 3_000);

  // Close socket.io FIRST and drop client connections. Otherwise the live
  // WebSocket connections keep httpServer.close()'s callback from ever firing,
  // which is what made shutdown drag out to the hard-exit timeout.
  try {
    io.disconnectSockets(true);
    io.close();
  } catch {
    /* best effort */
  }

  await services.stopAll().catch(() => {});
  connectors.disposeAll();
  httpServer.close(() => {
    clearTimeout(hardExit);
    console.log("[MCA Server] Stopped");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows: NSSM's default stop sends a console Ctrl+Break, surfaced as SIGBREAK.
process.on("SIGBREAK", shutdown);
