// Shared secret between the API server and the deployer process.
//
// Both services run on localhost on the same box, so this isn't a defence
// against a network attacker — it's a *misconfiguration* guard: if anything
// else on the machine accidentally hits `/api/repair/*`, it gets a 401
// instead of triggering a deploy. The token also makes the boundary explicit
// in logs/audit.
//
// Resolution order (first hit wins):
//   1. `MCA_DEPLOY_TOKEN` env var (preferred — set by the installer)
//   2. `<repoRoot>/logs/.deploy-token` on disk (persistent across restarts)
//   3. Freshly generated 32-byte hex token, written to (2) for next time.
//
// The on-disk file is mode 0600 on POSIX and via NTFS ACLs we'd rely on the
// repo's existing protection on Windows (writing inside `logs/` which is
// already owned by the installing user).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

export interface DeployTokenOptions {
  /** Repository root — used to locate `logs/.deploy-token`. */
  repoDir: string;
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv;
}

const TOKEN_FILE_REL = path.join("logs", ".deploy-token");

/**
 * Resolve the shared deploy token, creating it if neither env nor disk has one.
 * Idempotent: repeated calls return the same value within a process.
 */
export function resolveDeployToken(opts: DeployTokenOptions): string {
  const env = opts.env ?? process.env;
  const fromEnv = (env.MCA_DEPLOY_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;

  const tokenPath = path.join(opts.repoDir, TOKEN_FILE_REL);
  if (existsSync(tokenPath)) {
    const onDisk = readFileSync(tokenPath, "utf8").trim();
    if (onDisk) return onDisk;
  }

  // Generate a fresh token. 32 bytes hex = 64 chars — easy to copy/paste,
  // way above any sane brute-force threshold for a local-only check.
  const fresh = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, fresh + "\n", { encoding: "utf8" });
  try {
    // Owner-read/write only. No-op on Windows in practice (Node's chmod
    // is a partial shim) but harmless and meaningful on POSIX.
    chmodSync(tokenPath, 0o600);
  } catch {
    /* best effort */
  }
  return fresh;
}

/** Path where the token would be written, for installer scripts to surface. */
export function deployTokenPath(repoDir: string): string {
  return path.join(repoDir, TOKEN_FILE_REL);
}
