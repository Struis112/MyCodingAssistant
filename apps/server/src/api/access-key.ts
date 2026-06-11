// LAN access gate: a single shared key required for any non-loopback request.
//
// Why: the agent executes shell commands with the service's privileges, so an
// open port on the LAN is effectively remote code execution for anyone on the
// network. This gate closes that hole with minimal ceremony — local processes
// (deployer, watch-safe, health probes) stay exempt via the loopback check,
// and browsers send the key once via header (stored client-side).
//
// Key resolution: MCA_ACCESS_KEY env wins; otherwise a random key is generated
// once and persisted to logs/mca-access-key.txt so it survives restarts and
// the owner can read it off the box.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { Server as SocketIOServer } from "socket.io";

export const ACCESS_KEY_HEADER = "x-mca-key";

/** Loopback = same machine = trusted (service-to-service calls, health probes). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "");
  return a === "127.0.0.1" || a === "::1" || a.startsWith("127.");
}

/** Extract the presented key from header or Authorization: Bearer. */
export function presentedKey(headers: Record<string, unknown>): string | null {
  const direct = headers[ACCESS_KEY_HEADER];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

/** Pure decision: is this request allowed through the gate? */
export function checkAccess(opts: {
  key: string;
  remoteAddress: string | undefined;
  headers: Record<string, unknown>;
}): boolean {
  if (isLoopbackAddress(opts.remoteAddress)) return true;
  return presentedKey(opts.headers) === opts.key;
}

/**
 * Resolve the gate key: env override, else read the key file, else generate
 * and persist a new one. Never throws — an unreadable file just means a fresh
 * key (and the old one shows up as "key rejected", not a crash).
 */
export function resolveAccessKey(keyFile: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MCA_ACCESS_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(keyFile)) {
      const k = readFileSync(keyFile, "utf8").trim();
      if (k) return k;
    }
  } catch {
    /* fall through to generate */
  }
  const fresh = randomBytes(24).toString("hex");
  try {
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, fresh + "\n", "utf8");
  } catch {
    /* in-memory only this boot; still better than no gate */
  }
  return fresh;
}

/** Express middleware. CORS preflights pass (they carry no credentials). */
export function createAccessKeyMiddleware(key: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    if (checkAccess({ key, remoteAddress: req.socket.remoteAddress, headers: req.headers })) {
      return next();
    }
    res.status(401).json({ error: "access key required" });
  };
}

/** Socket.io connection guard: same rule, key arrives in handshake auth. */
export function installAccessKeySocketGuard(io: SocketIOServer, key: string): void {
  io.use((socket, next) => {
    const presented =
      typeof socket.handshake.auth?.key === "string"
        ? socket.handshake.auth.key
        : presentedKey(socket.handshake.headers as Record<string, unknown>);
    if (isLoopbackAddress(socket.handshake.address) || presented === key) return next();
    next(new Error("access key required"));
  });
}
