import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDeployLock, readDeployLock } from "./deploy-bounce-lock.js";

describe("deploy-bounce-lock", () => {
  let repoDir: string;
  const lockPath = (dir: string) => path.join(dir, "logs", ".deploy-bounce-lock");

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), "mca-lock-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("acquireDeployLock writes a JSON file readable by readDeployLock", () => {
    const handle = acquireDeployLock(repoDir, "activating", { sha: "abc123" });
    expect(existsSync(lockPath(repoDir))).toBe(true);
    const seen = readDeployLock(repoDir);
    expect(seen).not.toBeNull();
    expect(seen!.phase).toBe("activating");
    expect(seen!.sha).toBe("abc123");
    expect(seen!.pid).toBe(process.pid);
    expect(handle.info.phase).toBe("activating");
  });

  it("release() removes the lock file and is idempotent", () => {
    const handle = acquireDeployLock(repoDir, "verifying");
    expect(existsSync(lockPath(repoDir))).toBe(true);
    handle.release();
    expect(existsSync(lockPath(repoDir))).toBe(false);
    // Second release must NOT throw.
    expect(() => handle.release()).not.toThrow();
  });

  it("release() never throws even if the file was removed externally", () => {
    const handle = acquireDeployLock(repoDir, "x");
    rmSync(lockPath(repoDir));
    expect(() => handle.release()).not.toThrow();
  });

  it("readDeployLock returns null when no lock exists", () => {
    expect(readDeployLock(repoDir)).toBeNull();
  });

  it("readDeployLock treats locks older than staleAfterMs as nonexistent", () => {
    // Write a stale lock by hand (acquiredAt in the deep past).
    mkdirSync(path.join(repoDir, "logs"), { recursive: true });
    writeFileSync(
      lockPath(repoDir),
      JSON.stringify({ acquiredAt: 0, pid: 12345, phase: "activating" }),
    );
    expect(readDeployLock(repoDir, { staleAfterMs: 1_000 })).toBeNull();
  });

  it("readDeployLock with removeIfStale: true cleans up the dead file", () => {
    mkdirSync(path.join(repoDir, "logs"), { recursive: true });
    writeFileSync(
      lockPath(repoDir),
      JSON.stringify({ acquiredAt: 0, pid: 12345, phase: "activating" }),
    );
    readDeployLock(repoDir, { staleAfterMs: 1_000, removeIfStale: true });
    expect(existsSync(lockPath(repoDir))).toBe(false);
  });

  it("readDeployLock returns null on malformed JSON instead of throwing", () => {
    mkdirSync(path.join(repoDir, "logs"), { recursive: true });
    writeFileSync(lockPath(repoDir), "not json");
    expect(readDeployLock(repoDir)).toBeNull();
  });

  it("readDeployLock returns null when required fields are missing", () => {
    mkdirSync(path.join(repoDir, "logs"), { recursive: true });
    writeFileSync(lockPath(repoDir), JSON.stringify({ pid: 1 })); // no acquiredAt/phase
    expect(readDeployLock(repoDir)).toBeNull();
  });

  it("a fresh lock overwrites a stale one atomically", () => {
    // Pre-existing stale lock from a dead deployer.
    mkdirSync(path.join(repoDir, "logs"), { recursive: true });
    writeFileSync(
      lockPath(repoDir),
      JSON.stringify({ acquiredAt: 0, pid: 999999, phase: "activating" }),
    );
    const handle = acquireDeployLock(repoDir, "building", { sha: "new" });
    const seen = readDeployLock(repoDir);
    expect(seen!.phase).toBe("building");
    expect(seen!.sha).toBe("new");
    expect(seen!.pid).toBe(process.pid);
    handle.release();
  });

  it("the on-disk file is valid JSON (atomic write semantics)", () => {
    acquireDeployLock(repoDir, "smoking");
    // Read raw bytes and parse — must succeed.
    const raw = readFileSync(lockPath(repoDir), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.phase).toBe("smoking");
  });
});
