// Access audit log — append-only JSONL of every authenticated HTTP request.
//
// Purpose: cost-anomaly forensics. If the Anthropic bill spikes, we want a
// per-user request trail without standing up a database. JSONL is grep-able,
// rotates cleanly with logrotate / Windows scheduled tasks, and survives
// process crashes (each line is flushed independently).
//
// Performance: writes are fire-and-forget `fs.appendFile`. We never await
// inside the request hot path — losing one line during a crash is
// acceptable; blocking every request on disk I/O is not.
//
// Privacy: we log the verified email + country claim from Cloudflare Access,
// plus method/path/status/duration. We deliberately do NOT log query strings,
// request bodies, or auth tokens.
//
// No-op when `enabled` is false — keeps dev runs from writing logs nobody
// reads.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

export interface AccessAuditConfig {
  /** Master switch — usually mirrors CfAccessConfig.enabled. */
  enabled: boolean;
  /** Absolute path to the JSONL log file. Parent dir is created on first write. */
  filePath: string;
}

export interface AccessAuditEntry {
  ts: string;
  email: string;
  method: string;
  path: string;
  status: number;
  durMs: number;
  country?: string;
  ip?: string;
}

export interface AccessAuditLogger {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Exposed for tests / graceful shutdown. */
  flushPending: () => Promise<void>;
}

export function createAccessAuditLogger(cfg: AccessAuditConfig): AccessAuditLogger {
  // When disabled, return a pass-through. Avoids any fs work, any allocation
  // per request, and means the call site doesn't need conditional wiring.
  if (!cfg.enabled) {
    return {
      middleware: (_req, _res, next) => next(),
      flushPending: async () => {},
    };
  }

  let dirEnsured = false;
  // Track in-flight writes so tests / shutdown can await them.
  const pending = new Set<Promise<void>>();

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    await mkdir(path.dirname(cfg.filePath), { recursive: true });
    dirEnsured = true;
  }

  function write(entry: AccessAuditEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const p = (async () => {
      try {
        await ensureDir();
        await appendFile(cfg.filePath, line, "utf8");
      } catch (err) {
        // Audit failure must never break the request. Warn once per error
        // shape; in practice this fires only on disk-full / permission issues.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[access-audit] failed to append: ${msg}`);
      }
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    // Anonymous requests (e.g. /healthz exempted upstream) have no user —
    // nothing meaningful to audit, so skip.
    const email = req.user?.email;
    if (!email) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      const durMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      write({
        ts: new Date().toISOString(),
        email,
        method: req.method,
        // `req.path` strips query string — intentional, see Privacy note above.
        path: req.path,
        status: res.statusCode,
        durMs: Math.round(durMs * 100) / 100,
        country: req.user?.country,
        // Honours `app.set("trust proxy", ...)` if the caller configured it;
        // otherwise falls back to the socket address.
        ip: req.ip,
      });
    });

    next();
  }

  return {
    middleware,
    flushPending: async () => {
      await Promise.all(pending);
    },
  };
}
