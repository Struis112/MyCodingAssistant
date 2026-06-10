// Cloudflare Access JWT verification — the second lock on the front door.
//
// Architecture (from the outside in):
//
//   Browser ──HTTPS──▶ Cloudflare edge ─ Tunnel ─▶ MCA
//                          │
//                          ├─ Access SSO (Google / GitHub / email OTP)
//                          ├─ WAF + bot mitigation + rate limit
//                          └─ Issues `Cf-Access-Jwt-Assertion` header on
//                             every authenticated request
//
//   This middleware verifies that header on the MCA side. Two reasons we
//   verify server-side even though Cloudflare already authenticated:
//
//     1. Defense in depth. If the tunnel ever leaks the origin (config drift,
//        someone exposing a public port by accident), the app refuses
//        anonymous traffic instead of burning Anthropic credits.
//     2. We get `req.user.email` to write into the audit log.
//
// Behaviour:
//   - REQUIRE_CF_ACCESS_JWT !== "true"  → middleware is a no-op (dev mode)
//   - REQUIRE_CF_ACCESS_JWT === "true"  → enforced; missing/invalid → 401
//
// Fail-closed: if JWKS fetch fails when enforcement is on, every request is
// rejected. We NEVER default-allow on enforcement errors.

import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Payload Cloudflare Access embeds in the assertion. */
export interface CfAccessPayload extends JWTPayload {
  email?: string;
  identity_nonce?: string;
  country?: string;
  /** Audience tag of the Access Application — must match CF_ACCESS_AUD. */
  aud?: string | string[];
}

/** What the verified user looks like on the request object. */
export interface AccessUser {
  email: string;
  country?: string;
  /** Raw verified payload, for audit logging. */
  payload: CfAccessPayload;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AccessUser;
  }
}

export interface CfAccessConfig {
  /** Master switch. When false the middleware is a no-op pass-through. */
  enabled: boolean;
  /** e.g. "yourteam.cloudflareaccess.com" — no protocol. */
  teamDomain: string;
  /** Application Audience (AUD) tag from the Access Application. */
  audience: string;
  /**
   * Paths exempt from auth — `/healthz` is the only safe default. We deliberately
   * do NOT exempt `/readyz` because it pokes the Pi connector.
   */
  publicPaths?: string[];
}

/**
 * Read configuration from the environment. Validates that, when enforcement is
 * on, both team-domain and audience are present — otherwise we'd silently
 * accept any signed JWT.
 */
export function readCfAccessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CfAccessConfig {
  const enabled = env.REQUIRE_CF_ACCESS_JWT === "true";
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim();
  const audience = (env.CF_ACCESS_AUD ?? "").trim();

  if (enabled && (!teamDomain || !audience)) {
    throw new Error(
      "[cf-access] REQUIRE_CF_ACCESS_JWT=true but CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are unset. " +
        "Refusing to start — that would default-allow.",
    );
  }

  return {
    enabled,
    teamDomain,
    audience,
    publicPaths: ["/healthz"],
  };
}

/**
 * Build the JWKS resolver. Exported so tests can swap in a fake.
 *
 * jose's `createRemoteJWKSet` caches keys in-process with built-in TTL (10 min
 * by default) and a small grace window on rotation, so this is one network
 * call per ~10 minutes regardless of request volume.
 */
export function createCfAccessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  return createRemoteJWKSet(url, {
    cacheMaxAge: 10 * 60_000,
    cooldownDuration: 30_000,
  });
}

/**
 * Verify a raw assertion against the configured team domain + audience.
 * Returns the verified payload on success, throws on any failure.
 *
 * Exported so the Socket.IO middleware can call it directly on the
 * `Cf-Access-Jwt-Assertion` header sent during handshake.
 */
export async function verifyCfAccessJwt(
  jwt: string,
  cfg: CfAccessConfig,
  jwks: ReturnType<typeof createRemoteJWKSet>,
): Promise<CfAccessPayload> {
  const { payload } = await jwtVerify(jwt, jwks, {
    audience: cfg.audience,
    issuer: `https://${cfg.teamDomain}`,
  });
  return payload as CfAccessPayload;
}

/**
 * Build the Express middleware. Pass `jwks` only in tests — production should
 * use the default (a real JWKS pointing at the team domain).
 */
export function createCfAccessMiddleware(
  cfg: CfAccessConfig,
  jwks?: ReturnType<typeof createRemoteJWKSet>,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const publicPaths = new Set(cfg.publicPaths ?? []);
  const keys = jwks ?? (cfg.enabled ? createCfAccessJwks(cfg.teamDomain) : undefined);

  return async function cfAccessMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!cfg.enabled) {
      next();
      return;
    }

    if (publicPaths.has(req.path)) {
      next();
      return;
    }

    const jwt =
      (req.header("Cf-Access-Jwt-Assertion") ?? "").trim() ||
      // The cookie variant is what browsers send for subresource WebSocket
      // upgrades that occasionally drop the header.
      extractAccessCookie(req.header("cookie") ?? "");

    if (!jwt) {
      res.status(401).json({ error: "Missing Cloudflare Access assertion" });
      return;
    }

    if (!keys) {
      // Defensive — should be impossible because `enabled` implies we created keys.
      res.status(500).json({ error: "Auth misconfigured" });
      return;
    }

    try {
      const payload = await verifyCfAccessJwt(jwt, cfg, keys);
      if (!payload.email) {
        res.status(401).json({ error: "Assertion missing email claim" });
        return;
      }
      req.user = {
        email: payload.email,
        country: payload.country,
        payload,
      };
      next();
    } catch (err) {
      // Fail-closed: any verification error (bad signature, wrong aud, expired,
      // JWKS fetch error) ends the request. We log a short reason but never
      // leak token contents.
      const reason = err instanceof Error ? err.message : "verification failed";
      console.warn(`[cf-access] denied request to ${req.path}: ${reason}`);
      res.status(401).json({ error: "Invalid Cloudflare Access assertion" });
    }
  };
}

/** Parse `CF_Authorization=<jwt>` out of a Cookie header. */
function extractAccessCookie(cookieHeader: string): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "CF_Authorization") return rest.join("=").trim();
  }
  return "";
}
