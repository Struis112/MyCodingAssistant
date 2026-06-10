// Repair-loop HTTP surface (Phase 3).
//
// Endpoints (all gated by the shared deploy-token, see deploy-token.ts):
//
//   POST /api/repair/prompt   body: { attempt, failedPhase, logs, elapsedMs, remainingMs }
//                             resp: { newSha: string | null, reason }
//   POST /api/repair/parked   body: { reason, attempts, liveSha?, summary? }
//                             resp: { ok: true }
//
// Why HTTP between two processes on the same machine: the deployer is a
// separate NSSM service (failure-domain isolation, see start-deployer.ts).
// HTTP is the existing IPC the deployer already uses to bounce the web; we
// reuse the same channel rather than inventing pipes/sockets.

import { timingSafeEqual } from "node:crypto";
import type { Application, NextFunction, Request, Response } from "express";
import type { RepairSessionService } from "../services/repair-session.js";

export interface RepairRoutesDeps {
  service: RepairSessionService;
  /** The shared secret both services agree on. Empty disables auth (NOT recommended). */
  token: string;
}

/** Header name the deployer sends; case-insensitive in HTTP, lower-cased for compares. */
const TOKEN_HEADER = "x-mca-deploy-token";

/**
 * Constant-time comparison so a misbehaving client can't time the rejection
 * to discover the token. node:crypto.timingSafeEqual requires equal-length
 * buffers, so we short-circuit the length check first.
 *
 * Imported at the top of the module — NOT via require(), because this
 * workspace is `"type": "module"` and CommonJS require is undefined at
 * runtime. (vitest provides a require shim which is why this wasn't caught
 * by unit tests; we now have a smoke-runtime regression in mind.)
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Express middleware: 401 unless `X-MCA-Deploy-Token` matches the configured token. */
export function createDeployTokenGuard(token: string) {
  return function deployTokenGuard(req: Request, res: Response, next: NextFunction): void {
    if (!token) {
      // Auth disabled — only acceptable in tests; log loudly the first time.
      next();
      return;
    }
    const supplied = (req.header(TOKEN_HEADER) ?? "").trim();
    if (!supplied || !safeEqual(supplied, token)) {
      res.status(401).json({ error: "Missing or invalid deploy token" });
      return;
    }
    next();
  };
}

export function registerRepairRoutes(app: Application, deps: RepairRoutesDeps): void {
  const guard = createDeployTokenGuard(deps.token);

  app.post("/api/repair/prompt", guard, async (req, res) => {
    const { attempt, failedPhase, logs, elapsedMs, remainingMs } = req.body ?? {};
    // Basic shape validation. The deployer is the only legitimate caller so
    // we can be strict; better to 400 a malformed request than try to guess.
    if (
      typeof attempt !== "number" ||
      typeof failedPhase !== "string" ||
      typeof logs !== "string" ||
      typeof elapsedMs !== "number" ||
      typeof remainingMs !== "number"
    ) {
      res.status(400).json({ error: "Invalid body shape" });
      return;
    }
    try {
      const resolution = await deps.service.requestRepair({
        attempt,
        failedPhase,
        logs,
        elapsedMs,
        remainingMs,
      });
      res.json(resolution);
    } catch (err) {
      // Bubble up as 500 — the deployer will log it and PARK on its end.
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/repair/parked", guard, (req, res) => {
    const { reason, attempts, summary, liveSha } = req.body ?? {};
    if (typeof reason !== "string" || typeof attempts !== "number") {
      res.status(400).json({ error: "Invalid body shape" });
      return;
    }
    try {
      deps.service.recordPark({ reason, attempts, summary, liveSha });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
