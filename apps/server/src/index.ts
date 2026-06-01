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
import { WebSupervisor, type WebStatus } from "./services/web-supervisor.js";
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

const webSupervisor =
  process.env.MCA_SUPERVISE_WEB === "1" ? new WebSupervisor({ webDir, port: webPort }) : null;

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    web: webSupervisor?.getStatus() ?? { state: "disabled" },
  });
});

// Web supervisor status + manual control
app.get("/api/web/status", (_req, res) => {
  res.json(webSupervisor?.getStatus() ?? { state: "disabled" });
});

app.post("/api/web/restart", async (_req, res) => {
  if (!webSupervisor) {
    res.status(400).json({
      error:
        "Web supervisor is not running. Start the server with MCA_SUPERVISE_WEB=1 (or `npm run start`).",
    });
    return;
  }
  try {
    await webSupervisor.restart();
    res.json({ success: true, status: webSupervisor.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

registerApiRoutes(app, piSessionManager, { cwd: PROJECT_ROOT });
registerWebSocketHandlers(io, piSessionManager);

// Forward web supervisor status to all connected clients so a future UI
// can show a small indicator.
if (webSupervisor) {
  webSupervisor.on("status", (status: WebStatus) => {
    io.emit("web:status", status);
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[MCA Server] Running on http://${HOST}:${PORT}`);
  console.log("[MCA Server] WebSocket ready for frontend connections");
  if (webSupervisor) {
    console.log(`[MCA Server] Web supervisor enabled — will keep port ${webPort} alive`);
    void webSupervisor.start();
  } else {
    console.log("[MCA Server] Web supervisor disabled (set MCA_SUPERVISE_WEB=1 to enable)");
  }
});

async function shutdown() {
  console.log("\n[MCA Server] Shutting down...");
  if (webSupervisor) {
    await webSupervisor.stop().catch(() => {});
  }
  connectors.disposeAll();
  httpServer.close(() => {
    console.log("[MCA Server] Stopped");
    process.exit(0);
  });
  // Hard-exit after 8s if something hangs
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
