// MyCodingAssistant Server - Entry point
// Integrates one or more coding-agent harnesses via WebSocket + REST API.
// Today there's a single connector (Pi SDK); future harnesses (Claude Code,
// Opencode Go) register themselves the same way.

import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectorRegistry } from "./connectors/registry.js";
import { createPiConnector } from "./connectors/pi/index.js";
import { ServiceRegistry, createWebService } from "./services/service-registry.js";
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
// Allow the frontend origin to be overridden via env so devs running the web
// app on a non-default port (e.g. when 7642 is already taken) don't get
// CORS errors. Default mirrors the web `next dev -p 7642`.
const WEB_ORIGIN = process.env.MCA_WEB_ORIGIN || "http://localhost:7642";

// Express app
const app = express();
app.use(cors({ origin: WEB_ORIGIN }));
app.use(express.json());

// HTTP server
const httpServer = createServer(app);

// WebSocket server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: WEB_ORIGIN,
    methods: ["GET", "POST"],
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
registerWebSocketHandlers(io, piSessionManager);

// Forward service-status changes to all connected clients so the Services
// screen updates live.
services.on("status", (list: ServiceStatus[]) => {
  io.emit("services:status", list);
});

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
