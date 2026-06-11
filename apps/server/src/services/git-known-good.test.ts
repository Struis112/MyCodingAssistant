import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitKnownGoodStore } from "./git-known-good.js";

// These tests run REAL git against a throwaway repo in the OS temp dir, so they
// never touch the project's own repository.

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

describe.runIf(gitAvailable)("GitKnownGoodStore (real git, temp repo)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mca-git-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    git(dir, "checkout", "-q", "-b", "staging");
    commit(dir, "app.txt", "v1 (known good)", "v1");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mark() creates the live baseline at the current staging tip", async () => {
    const store = new GitKnownGoodStore({ repoDir: dir });
    const stagingTip = git(dir, "rev-parse", "staging");

    await store.mark();

    expect(git(dir, "rev-parse", "live")).toBe(stagingTip);
  });

  it("mark() is idempotent — leaves an existing live ref untouched", async () => {
    const store = new GitKnownGoodStore({ repoDir: dir });
    await store.mark();
    const live1 = git(dir, "rev-parse", "live");
    commit(dir, "app.txt", "v2 candidate", "v2"); // advance staging
    await store.mark();
    expect(git(dir, "rev-parse", "live")).toBe(live1); // unchanged
  });

  it("rollback() returns the working tree to the known-good version", async () => {
    const store = new GitKnownGoodStore({ repoDir: dir });
    await store.mark(); // live = v1
    const good = git(dir, "rev-parse", "live");

    // A bad candidate lands on staging.
    commit(dir, "app.txt", "v2 BROKEN", "v2 broken");
    expect(git(dir, "rev-parse", "staging")).not.toBe(good);

    await store.rollback();

    // staging is back at the known-good commit + working tree restored.
    expect(git(dir, "rev-parse", "staging")).toBe(good);
    expect(git(dir, "rev-parse", "HEAD")).toBe(good);
  });

  it("promote() moves live to the validated candidate", async () => {
    const store = new GitKnownGoodStore({ repoDir: dir });
    await store.mark(); // live = v1

    const candidate = commit(dir, "app.txt", "v2 GOOD", "v2 good");
    await store.promote();

    expect(git(dir, "rev-parse", "live")).toBe(candidate);
  });

  it("rollback() parks orphanable commits on a rescue branch", async () => {
    const notes: string[] = [];
    const store = new GitKnownGoodStore({ repoDir: dir, onNote: (n) => notes.push(n) });
    await store.mark(); // live = v1

    const doomed = commit(dir, "app.txt", "v2 would be erased", "v2");
    await store.rollback();

    // The commit is no longer on staging but IS reachable from a rescue branch.
    const branches = git(dir, "branch", "--list", "rescue/*", "--format=%(refname:short)");
    expect(branches).not.toBe("");
    expect(git(dir, "rev-parse", branches.split("\n")[0])).toBe(doomed);
    expect(notes.some((n) => n.includes("rescued 1 commit"))).toBe(true);
  });

  it("rollback() stashes uncommitted tracked changes instead of erasing them", async () => {
    const notes: string[] = [];
    const store = new GitKnownGoodStore({ repoDir: dir, onNote: (n) => notes.push(n) });
    await store.mark();
    commit(dir, "app.txt", "v2", "v2");

    // Uncommitted WIP on a tracked file — previously destroyed by checkout -f.
    writeFileSync(path.join(dir, "app.txt"), "WIP not yet committed");
    await store.rollback();

    const stashes = git(dir, "stash", "list");
    expect(stashes).toContain("mca-rollback-rescue");
    expect(notes.some((n) => n.includes("stashed"))).toBe(true);
  });

  it("rollback() with clean tree and no extra commits creates no rescue artifacts", async () => {
    const store = new GitKnownGoodStore({ repoDir: dir });
    await store.mark();
    await store.rollback();
    expect(git(dir, "branch", "--list", "rescue/*")).toBe("");
    expect(git(dir, "stash", "list")).toBe("");
  });

  it("full cycle: mark → bad candidate → rollback → good candidate → promote", async () => {
    const store = new GitKnownGoodStore({ repoDir: dir });
    await store.mark();
    const v1 = git(dir, "rev-parse", "live");

    // Bad attempt → rollback keeps live on v1.
    commit(dir, "app.txt", "broken", "broken");
    await store.rollback();
    expect(git(dir, "rev-parse", "live")).toBe(v1);
    expect(git(dir, "rev-parse", "staging")).toBe(v1);

    // Fixed attempt → promote advances live.
    const v2 = commit(dir, "app.txt", "fixed", "fixed");
    await store.promote();
    expect(git(dir, "rev-parse", "live")).toBe(v2);
  });
});
