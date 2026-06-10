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
import { startWatchSafe } from "./services/watch-safe-restarter.js";
import { runDevPrecheck } from "./services/dev-precheck.js";
import { readDeployLock } from "./services/deploy-bounce-lock.js";
import {
  appParametersFor,
  buildTargetFor,
  currentRunMode,
  type RunMode,
} from "./services/run-mode.js";
import type { ServiceStatus } from "./services/service-supervisor.js";
import { registerApiRoutes } from "./api/routes.js";
import { registerWebSocketHandlers } from "./websocket/handlers.js";
import { createCfAccessMiddleware, readCfAccessConfigFromEnv } from "./api/cf-access.js";
import { installCfAccessSocketGuard } from "./websocket/cf-access-guard.js";
import { createAccessAuditLogger } from "./services/access-audit.js";
import { resolveDeployToken } from "./services/deploy-token.js";
import { RepairSessionService } from "./services/repair-session.js";
import { registerRepairRoutes } from "./api/repair-routes.js";

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

// ----- Liveness probe (always unauthenticated) -----
// Cloudflare Tunnel + Docker healthcheck poll this. Deliberately minimal: no
// DB hit, no auth, no dependency checks. "The server process is alive and
// answering HTTP" is all this confirms. Use /readyz for dependency state.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ----- Cloudflare Access JWT enforcement -----
// Off by default (dev). In prod, set:
//   REQUIRE_CF_ACCESS_JWT=true
//   CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
//   CF_ACCESS_AUD=<application audience tag>
// The factory throws on enabled+missing-config so we can't accidentally
// default-allow. Anything reaching the app after this point has a verified
// `req.user.email`.
const cfAccessCfg = readCfAccessConfigFromEnv();
app.use(createCfAccessMiddleware(cfAccessCfg));

// Audit log of every authenticated request — keyed on req.user.email. Cheap
// (JSONL append), invaluable for cost-anomaly investigation. No-op when
// enforcement is off.
const accessAudit = createAccessAuditLogger({
  enabled: cfAccessCfg.enabled,
  // Lives next to other operational logs.
  filePath: path.join(PROJECT_ROOT, "logs", "access.log"),
});
app.use(accessAudit.middleware);

// ----- Readiness probe (still public, but checks deeper state) -----
// Right after Access so it survives the auth gate; reports degraded if the
// Pi connector hasn't initialised. Public because Cloudflare Health Checks
// don't carry an Access JWT.
app.get("/readyz", (_req, res) => {
  const piReady = Boolean(piSessionManager);
  if (!piReady) {
    res.status(503).json({ status: "not_ready", reasons: ["pi_connector_missing"] });
    return;
  }
  res.json({ status: "ready" });
});

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

// ----- Model auto-sync -----
// Keep the model picker current with the provider's authoritative list, so new
// models (and their effort levels) show up without a manual edit or SDK update.
const MODEL_SYNC_INTERVAL_MS = 15 * 60_000; // 15 minutes
let lastModelSync: import("./services/model-sync.js").SyncResult | null = null;
// HTTP statuses we'll retry transparently. 401 is the headline one — right
// after boot the Pi SDK's OAuth refresh sometimes hasn't completed before
// our 8s startup sync fires, and Anthropic rejects the stale bearer with
// HTTP 401. By the time we retry 5 seconds later, refresh has run and we
// get 200. 429 (rate-limit) is here for free — same backoff strategy.
const MODEL_SYNC_TRANSIENT = /HTTP (401|429|5\d\d)/;
async function runModelSync(reason: string): Promise<void> {
  if (!piSessionManager.syncLatestModels) return;
  // Retry on transient HTTP failures: 5s, 10s, 20s, 40s. Total worst-case
  // wait ~75s before we give up and log the final failure — well below the
  // 15-minute interval, so a real outage still gets surfaced eventually but
  // a boot-time race doesn't pollute the err log.
  const delaysMs = reason === "startup" ? [5_000, 10_000, 20_000, 40_000] : [];
  let r = await piSessionManager.syncLatestModels();
  for (let i = 0; i < delaysMs.length && r.error && MODEL_SYNC_TRANSIENT.test(r.error); i++) {
    console.log(
      `[models] sync (${reason}) transient ${r.error} — retry in ${delaysMs[i] / 1000}s ` +
        `(attempt ${i + 2}/${delaysMs.length + 1})`,
    );
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    // eslint-disable-next-line no-await-in-loop
    r = await piSessionManager.syncLatestModels();
  }
  lastModelSync = r;
  if (r.error) console.warn(`[models] sync (${reason}) failed: ${r.error}`);
  else if (r.added.length) console.log(`[models] sync (${reason}) added: ${r.added.join(", ")}`);
  else console.log(`[models] sync (${reason}) — up to date (${r.totalOffered} offered)`);
}
app.get("/api/models/sync", (_req, res) => {
  res.json({
    supported: !!piSessionManager.syncLatestModels,
    last: lastModelSync,
    intervalMs: MODEL_SYNC_INTERVAL_MS,
  });
});
app.post("/api/models/sync", async (_req, res) => {
  if (!piSessionManager.syncLatestModels) {
    res.status(400).json({ ok: false, error: "model sync not supported by this connector" });
    return;
  }
  await runModelSync("manual");
  res.json({ ok: !lastModelSync?.error, result: lastModelSync });
});

registerApiRoutes(app, piSessionManager, { cwd: PROJECT_ROOT });

// ----- Self-healing repair loop (Phase 3) -----
// One dedicated, visible chat session ("Self-healing deploy") that the
// separate deployer process drives via POST /api/repair/prompt. The session
// is fully autonomous — the AI reads logs, edits, and commits to `staging`
// without human input — but visible in the UI so a human CAN watch /
// interrupt / take over.
const deployToken = resolveDeployToken({ repoDir: PROJECT_ROOT });
const repairService = new RepairSessionService({
  manager: piSessionManager,
  repoDir: PROJECT_ROOT,
  model: process.env.MCA_REPAIR_MODEL || "anthropic/claude-sonnet-4-5",
  onPark: (ctx) => {
    // Broadcast to all connected clients so the Services screen can flag
    // "deploy parked" without polling. The chat itself also gets a system
    // follow-up via recordPark → ensureSession → followUp.
    io.emit("service:repairParked", ctx);
  },
});
registerRepairRoutes(app, { service: repairService, token: deployToken });
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

// Install the WebSocket-side guard BEFORE handlers register their listeners.
// Same JWT verification as Express — without this, an upgrade could bypass
// the HTTP gate entirely.
installCfAccessSocketGuard(io, cfAccessCfg);

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

// ----- Watch-safe in-process restarter (MCA_WATCH_SAFE=1) -----
// Replaces `tsx watch` for supervised dev: WE watch the server source, debounce,
// run a tsc precheck, and then `process.exit(0)` so the OS service manager
// (NSSM) brings us back on the new code. This adds two guarantees `tsx watch`
// doesn't give us:
//   1. We never restart mid-reply — the gate waits for `activeTurns === 0`.
//   2. We never restart onto a broken candidate — a failing `tsc --noEmit`
//      cancels the restart and re-arms on the next save (the safety net
//      missing in the 2026-06-10 incident).
// Off by default so a developer running `npm run dev:server` (under tsx watch)
// doesn't end up with two fighting watchers.
if (process.env.MCA_WATCH_SAFE === "1") {
  const serverDir = path.resolve(HERE, "..");
  const stopWatchSafe = startWatchSafe({
    watchDirs: [path.join(serverDir, "src")],
    activeTurns: () => {
      // Count sessions currently streaming a reply. ConnectorManager has
      // listActiveSessions(); duck-typed to avoid widening the interface for
      // a dev-only feature.
      try {
        return piSessionManager.listActiveSessions().filter((s) => s.isStreaming).length;
      } catch {
        return 0;
      }
    },
    precheck: async () => {
      // Cooperative-lock check: if the deployer is in the middle of a
      // build/validate/activate/verify cycle, it WILL bounce the API
      // service shortly via NSSM. Restarting from inside the same process
      // simultaneously is the exact race that caused the 2026-06-10
      // 'activation failed: web restart endpoint returned no response'
      // park. Abstain while the lock is fresh; the gate is re-armed for
      // the next source change, so the AI's fix (or the operator's edit)
      // still gets a restart — just after the deploy bounce is done.
      const lock = readDeployLock(PROJECT_ROOT, { removeIfStale: true });
      if (lock) {
        return {
          ok: false,
          logs:
            `deploy bounce in progress (phase=${lock.phase}, pid=${lock.pid}` +
            (lock.sha ? `, sha=${lock.sha.slice(0, 8)}` : "") +
            `) — abstaining; will re-evaluate on next change`,
        };
      }
      const r = await runDevPrecheck({ serverDir });
      // Surface only the tail (most actionable) to the gate's log channel.
      return { ok: r.ok, logs: r.ok ? undefined : r.logs.split("\n").slice(-12).join("\n") };
    },
    onRestart: () => {
      console.log("[watch-safe] graceful restart — exiting so the supervisor relaunches");
      // Same shutdown path as a SIGTERM — closes sockets, stops child services,
      // then exits 0. The OS service manager restarts us.
      void shutdown();
    },
    log: (msg) => console.log(`[watch-safe] ${msg}`),
  });
  // Best-effort cleanup on shutdown so we don't leak fs watchers.
  process.on("exit", () => {
    try {
      stopWatchSafe();
    } catch {
      /* best effort */
    }
  });
  console.log(`[watch-safe] watching ${path.join(serverDir, "src")} (precheck: tsc --noEmit)`);
}

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
  // Sync models shortly after boot, then every 15 minutes. Unref'd so it never
  // holds the process open during shutdown.
  setTimeout(() => void runModelSync("startup"), 8_000).unref();
  setInterval(() => void runModelSync("interval"), MODEL_SYNC_INTERVAL_MS).unref();
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

  // Forcibly drop any remaining HTTP keep-alive connections. Without this,
  // browser tabs / curl / the deployer's own probe sockets in keep-alive
  // state count as "in flight" to httpServer.close() and prevent its
  // callback from firing — which is exactly what made the watch-safe
  // restart hit "Forced exit (graceful close timed out)" instead of the
  // intended sub-second clean stop.
  // closeIdleConnections + closeAllConnections were added in Node 18.2; we
  // require >=22 elsewhere so they're always present, but we still optional-
  // chain in case a test runner stubs httpServer with an older shape.
  try {
    httpServer.closeIdleConnections?.();
    httpServer.closeAllConnections?.();
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
