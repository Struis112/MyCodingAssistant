// Deploy-bounce lock — cooperative file lock between the deployer process and
// the API server's in-process WatchSafeRestarter.
//
// Why this exists: the 2026-06-10 incident class. The deployer and watch-safe
// each independently know how to bounce the API service — the deployer via
// `nssm stop`+`nssm start` during its activate phase, watch-safe via
// `process.exit(0)`. If they trip at the same instant (e.g. a commit lands
// that triggers BOTH paths), watch-safe takes the API down while the
// deployer's activate is mid-flight, the deployer's web-restart probe
// returns ECONNREFUSED, activate fails, controller PARKs even though the
// commit is fine.
//
// This module is the cooperative signal. The deployer holds the lock for the
// duration of a deploy attempt; watch-safe reads it and abstains while held.
// Both processes are local, both run as the same Windows user, so a JSON file
// in logs/ is the right mechanism — no need for a kernel mutex.
//
// Safety properties:
//   * The lock is timestamped. A crashed deployer leaves a stale file behind,
//     so any reader (and the next deployer) treats locks older than
//     `staleAfterMs` (default 10 min) as nonexistent.
//   * Writes use a "write to temp + rename" atomic pattern so a reader never
//     sees a partial JSON.
//   * release() is idempotent and never throws — finally{} safety.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface DeployLockInfo {
  /** ms epoch when the lock was taken. */
  acquiredAt: number;
  /** Process id of the lock holder. */
  pid: number;
  /** Free-form label so logs can say *what* the lock is for ("activating", "rolling_back", …). */
  phase: string;
  /** Optional staging sha being deployed; helpful for the abstaining side's log. */
  sha?: string;
}

export interface DeployLockHandle {
  /** Idempotent + non-throwing. Safe to call from finally{}. */
  release: () => void;
  /** The info this handle wrote. */
  info: DeployLockInfo;
}

const LOCK_FILE_REL = path.join("logs", ".deploy-bounce-lock");
const DEFAULT_STALE_MS = 10 * 60_000;

function lockPath(repoDir: string): string {
  return path.join(repoDir, LOCK_FILE_REL);
}

/**
 * Acquire the deploy-bounce lock. Always succeeds (does not block on existing
 * locks) — the goal isn't mutual exclusion of deployers, it's signalling to
 * watch-safe. The DeployController is already single-flight within a process
 * via its own `deploying` flag.
 *
 * Atomic via write-temp + rename, so a reader never observes half a JSON.
 */
export function acquireDeployLock(
  repoDir: string,
  phase: string,
  opts: { sha?: string } = {},
): DeployLockHandle {
  const info: DeployLockInfo = {
    acquiredAt: Date.now(),
    pid: process.pid,
    phase,
    sha: opts.sha,
  };
  const p = lockPath(repoDir);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), "utf8");
  try {
    renameSync(tmp, p);
  } catch (err) {
    // If rename fails (rare — e.g. antivirus holding the file open) we still
    // tried; release() will best-effort unlink whichever path exists.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }

  let released = false;
  return {
    info,
    release: () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(p);
      } catch {
        /* missing file is fine — already released or never written */
      }
    },
  };
}

/**
 * Read the current lock. Returns null if no file exists OR if the file is
 * stale (older than `staleAfterMs`, default 10 min — a deployer that's been
 * holding it longer than that has almost certainly crashed).
 *
 * Stale-lock cleanup is opportunistic: callers can pass `{ removeIfStale:
 * true }` to delete the dead file in passing. Watch-safe never deletes — it
 * just abstains for fresh locks and treats stale as "not held".
 */
export function readDeployLock(
  repoDir: string,
  opts: { staleAfterMs?: number; removeIfStale?: boolean } = {},
): DeployLockInfo | null {
  const p = lockPath(repoDir);
  if (!existsSync(p)) return null;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let info: DeployLockInfo;
  try {
    const parsed = JSON.parse(raw) as Partial<DeployLockInfo>;
    if (
      typeof parsed.acquiredAt !== "number" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.phase !== "string"
    ) {
      return null;
    }
    info = {
      acquiredAt: parsed.acquiredAt,
      pid: parsed.pid,
      phase: parsed.phase,
      sha: typeof parsed.sha === "string" ? parsed.sha : undefined,
    };
  } catch {
    return null;
  }
  if (Date.now() - info.acquiredAt > staleAfterMs) {
    if (opts.removeIfStale) {
      try {
        unlinkSync(p);
      } catch {
        /* best effort */
      }
    }
    return null;
  }
  return info;
}
