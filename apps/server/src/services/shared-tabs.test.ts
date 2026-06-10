import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SCOPE, SharedTabsStore, sanitizeTabs } from "./shared-tabs.js";

// Silent logger so test runs don't print expected error noise.
const silentLogger = { error: () => {} };

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "mca-tabs-"));
}

describe("sanitizeTabs", () => {
  it("drops non-objects, non-string sessionFile, and empty paths", () => {
    expect(
      sanitizeTabs([
        null,
        "x",
        { sessionFile: "" },
        { sessionFile: 123 },
        { sessionFile: "/a.jsonl", name: "A" },
        { sessionFile: "/b.jsonl" }, // missing name → null
        { sessionFile: "/c.jsonl", name: 42 }, // bad name → null
      ]),
    ).toEqual([
      { sessionFile: "/a.jsonl", name: "A" },
      { sessionFile: "/b.jsonl", name: null },
      { sessionFile: "/c.jsonl", name: null },
    ]);
  });

  it("returns [] for non-arrays", () => {
    expect(sanitizeTabs(null)).toEqual([]);
    expect(sanitizeTabs(undefined)).toEqual([]);
    expect(sanitizeTabs({})).toEqual([]);
    expect(sanitizeTabs("hi")).toEqual([]);
  });
});

describe("SharedTabsStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = tmp();
    file = path.join(dir, "tabs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when the file doesn't exist", () => {
    const store = new SharedTabsStore(file, { logger: silentLogger });
    expect(store.get(DEFAULT_SCOPE)).toEqual([]);
    expect(store.scopesList()).toEqual([]);
  });

  it("set + get round-trips per scope and isolates scopes", () => {
    const store = new SharedTabsStore(file, { debounceMs: 5, logger: silentLogger });
    store.set("alice", [{ sessionFile: "/a.jsonl", name: "A" }]);
    store.set("bob", [{ sessionFile: "/b.jsonl", name: "B" }]);
    expect(store.get("alice")).toEqual([{ sessionFile: "/a.jsonl", name: "A" }]);
    expect(store.get("bob")).toEqual([{ sessionFile: "/b.jsonl", name: "B" }]);
    // No cross-scope leak.
    expect(store.get("eve")).toEqual([]);
  });

  it("get returns a fresh array (mutating the result doesn't corrupt the store)", () => {
    const store = new SharedTabsStore(file, { logger: silentLogger });
    store.set("u", [{ sessionFile: "/a.jsonl", name: "A" }]);
    const copy = store.get("u");
    copy.push({ sessionFile: "/EVIL.jsonl", name: "X" });
    expect(store.get("u")).toEqual([{ sessionFile: "/a.jsonl", name: "A" }]);
  });

  it("set sanitizes input (drops malformed rows)", () => {
    const store = new SharedTabsStore(file, { logger: silentLogger });
    const result = store.set("u", [
      { sessionFile: "/ok.jsonl", name: "ok" },
      { foo: "bar" },
      { sessionFile: 42 },
    ]);
    expect(result).toEqual([{ sessionFile: "/ok.jsonl", name: "ok" }]);
    expect(store.get("u")).toEqual([{ sessionFile: "/ok.jsonl", name: "ok" }]);
  });

  it("setting an empty list removes the scope", () => {
    const store = new SharedTabsStore(file, { logger: silentLogger });
    store.set("u", [{ sessionFile: "/a.jsonl", name: "A" }]);
    expect(store.scopesList()).toEqual(["u"]);
    store.set("u", []);
    expect(store.scopesList()).toEqual([]);
  });

  it("flush persists to disk atomically (no .tmp left behind)", async () => {
    const store = new SharedTabsStore(file, { debounceMs: 5, logger: silentLogger });
    store.set("u", [{ sessionFile: "/a.jsonl", name: "A" }]);
    await store.flush();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toEqual({
      version: 1,
      scopes: { u: [{ sessionFile: "/a.jsonl", name: "A" }] },
    });
  });

  it("debounces multiple set() calls into one write", async () => {
    const store = new SharedTabsStore(file, { debounceMs: 20, logger: silentLogger });
    store.set("u", [{ sessionFile: "/a.jsonl", name: "A" }]);
    store.set("u", [
      { sessionFile: "/a.jsonl", name: "A" },
      { sessionFile: "/b.jsonl", name: "B" },
    ]);
    store.set("u", [
      { sessionFile: "/a.jsonl", name: "A" },
      { sessionFile: "/b.jsonl", name: "B" },
      { sessionFile: "/c.jsonl", name: "C" },
    ]);
    // No write should be on disk yet (debounce still pending).
    expect(existsSync(file)).toBe(false);
    await store.flush();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.scopes.u).toHaveLength(3);
  });

  it("reloads existing v1 data on construction", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        scopes: { alice: [{ sessionFile: "/a.jsonl", name: "A" }] },
      }),
    );
    const store = new SharedTabsStore(file, { logger: silentLogger });
    expect(store.get("alice")).toEqual([{ sessionFile: "/a.jsonl", name: "A" }]);
  });

  it("migrates the legacy bare-array format into the default scope", async () => {
    writeFileSync(file, JSON.stringify([{ sessionFile: "/a.jsonl", name: "A" }]));
    const store = new SharedTabsStore(file, { logger: silentLogger });
    expect(store.get(DEFAULT_SCOPE)).toEqual([{ sessionFile: "/a.jsonl", name: "A" }]);
    // A flush should rewrite in the new shape.
    await store.flush();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.scopes[DEFAULT_SCOPE]).toEqual([{ sessionFile: "/a.jsonl", name: "A" }]);
  });

  it("survives a corrupt file (logs, falls back to empty)", () => {
    writeFileSync(file, "{ not json");
    const errors: unknown[][] = [];
    const store = new SharedTabsStore(file, {
      logger: { error: (...args) => errors.push(args) },
    });
    expect(store.get(DEFAULT_SCOPE)).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("flushSync writes immediately and clears any pending debounced flush", () => {
    const store = new SharedTabsStore(file, { debounceMs: 10_000, logger: silentLogger });
    store.set("u", [{ sessionFile: "/a.jsonl", name: "A" }]);
    // Debounced timer is pending; flushSync should override and write now.
    store.flushSync();
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.scopes.u).toEqual([{ sessionFile: "/a.jsonl", name: "A" }]);
  });
});
