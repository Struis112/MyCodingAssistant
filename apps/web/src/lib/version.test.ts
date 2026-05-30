import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./version";
import pkg from "../../package.json";

describe("APP_VERSION", () => {
  it("matches the web package.json version (did you forget to bump one?)", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("looks like semver (MAJOR.MINOR.PATCH)", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
