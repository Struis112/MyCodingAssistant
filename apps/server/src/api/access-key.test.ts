import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAccess, isLoopbackAddress, presentedKey, resolveAccessKey } from "./access-key.js";

describe("isLoopbackAddress", () => {
  it("accepts IPv4/IPv6 loopback incl. v4-mapped", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects LAN and missing addresses", () => {
    expect(isLoopbackAddress("192.168.1.50")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("presentedKey", () => {
  it("reads x-mca-key and Bearer", () => {
    expect(presentedKey({ "x-mca-key": "abc" })).toBe("abc");
    expect(presentedKey({ authorization: "Bearer xyz" })).toBe("xyz");
    expect(presentedKey({})).toBeNull();
  });
});

describe("checkAccess", () => {
  const key = "secret";
  it("allows loopback without a key", () => {
    expect(checkAccess({ key, remoteAddress: "::1", headers: {} })).toBe(true);
  });
  it("allows remote with the right key, rejects wrong/missing", () => {
    expect(
      checkAccess({ key, remoteAddress: "192.168.1.9", headers: { "x-mca-key": "secret" } }),
    ).toBe(true);
    expect(
      checkAccess({ key, remoteAddress: "192.168.1.9", headers: { "x-mca-key": "nope" } }),
    ).toBe(false);
    expect(checkAccess({ key, remoteAddress: "192.168.1.9", headers: {} })).toBe(false);
  });
});

describe("resolveAccessKey", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("env wins over file", () => {
    dir = mkdtempSync(join(tmpdir(), "mca-key-"));
    const f = join(dir, "key.txt");
    writeFileSync(f, "filekey\n");
    expect(resolveAccessKey(f, { MCA_ACCESS_KEY: "envkey" } as NodeJS.ProcessEnv)).toBe("envkey");
  });

  it("reads an existing file, generates + persists when absent", () => {
    dir = mkdtempSync(join(tmpdir(), "mca-key-"));
    const f = join(dir, "key.txt");
    const generated = resolveAccessKey(f, {} as NodeJS.ProcessEnv);
    expect(generated).toMatch(/^[0-9a-f]{48}$/);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf8").trim()).toBe(generated);
    // Stable across calls (reads the persisted file).
    expect(resolveAccessKey(f, {} as NodeJS.ProcessEnv)).toBe(generated);
  });
});
