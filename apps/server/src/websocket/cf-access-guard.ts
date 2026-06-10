// Socket.IO equivalent of the Express CF Access middleware.
//
// Cloudflare Access forwards the JWT to upgrade requests too, so we verify it
// once per handshake. Without this, a public origin would let any browser
// open a WebSocket and bypass the HTTP guard entirely.
//
// Fail-closed: rejects the connection on any verification failure or missing
// assertion when enforcement is on. Off-mode is a pass-through.

import type { Server, Socket } from "socket.io";
import type { createRemoteJWKSet } from "jose";
import {
  type AccessUser,
  type CfAccessConfig,
  createCfAccessJwks,
  verifyCfAccessJwt,
} from "../api/cf-access.js";

declare module "socket.io" {
  interface Socket {
    user?: AccessUser;
  }
}

/**
 * Install the guard onto a Socket.IO server. Call once, before
 * `registerWebSocketHandlers`.
 */
export function installCfAccessSocketGuard(
  io: Server,
  cfg: CfAccessConfig,
  jwks?: ReturnType<typeof createRemoteJWKSet>,
): void {
  if (!cfg.enabled) return;

  const keys = jwks ?? createCfAccessJwks(cfg.teamDomain);

  io.use(async (socket: Socket, next: (err?: Error) => void) => {
    try {
      const jwt = extractJwt(socket);
      if (!jwt) {
        next(new Error("missing Cloudflare Access assertion"));
        return;
      }
      const payload = await verifyCfAccessJwt(jwt, cfg, keys);
      if (!payload.email) {
        next(new Error("assertion missing email claim"));
        return;
      }
      socket.user = {
        email: payload.email,
        country: payload.country,
        payload,
      };
      next();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "verification failed";
      console.warn(`[cf-access:ws] denied socket ${socket.id}: ${reason}`);
      next(new Error("unauthorized"));
    }
  });
}

/** Cloudflare puts the assertion in a header on upgrade; some clients shove it in the cookie. */
function extractJwt(socket: Socket): string {
  const headers = socket.handshake.headers ?? {};
  const headerVal =
    pickHeader(headers["cf-access-jwt-assertion"]) ??
    pickHeader(headers["Cf-Access-Jwt-Assertion"]);
  if (headerVal) return headerVal.trim();

  const cookie = pickHeader(headers.cookie);
  if (!cookie) return "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "CF_Authorization") return rest.join("=").trim();
  }
  return "";
}

function pickHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
