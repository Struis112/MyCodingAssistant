import { describe, expect, it, vi } from "vitest";
import { runDevPrecheck } from "./dev-precheck.js";

const FAKE_DIR = "/repo/apps/server";

describe("runDevPrecheck", () => {
  it("returns ok when tsc exits 0", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, output: "" });
    const r = await runDevPrecheck({
      serverDir: FAKE_DIR,
      findTsc: () => "/tsc.js",
      tsconfigExists: () => true,
      run,
      now: (() => {
        let t = 0;
        return () => (t += 5);
      })(),
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(r.durationMs).toBe(5);
  });

  it("returns the tsc diagnostic on failure", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 2,
      output: "src/index.ts(29,1): error TS2307: Cannot find module './services/access-audit.js'.",
    });
    const r = await runDevPrecheck({
      serverDir: FAKE_DIR,
      findTsc: () => "/tsc.js",
      tsconfigExists: () => true,
      run,
    });
    expect(r.ok).toBe(false);
    expect(r.logs).toContain("TS2307");
    expect(r.logs).toContain("access-audit");
  });

  it("skips (ok:true) when tsc isn't installed", async () => {
    const run = vi.fn();
    const r = await runDevPrecheck({
      serverDir: FAKE_DIR,
      findTsc: () => null,
      tsconfigExists: () => true,
      run,
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("truncates very large outputs from the head so the last errors stay visible", async () => {
    const big = "noise\n".repeat(5000) + "FINAL_ERROR\n";
    const run = vi.fn().mockResolvedValue({ code: 1, output: big });
    const r = await runDevPrecheck({
      serverDir: FAKE_DIR,
      findTsc: () => "/tsc.js",
      tsconfigExists: () => true,
      run,
    });
    expect(r.ok).toBe(false);
    // The tail must always survive truncation — that's the most actionable bit.
    expect(r.logs.endsWith("FINAL_ERROR")).toBe(true);
    // And we actually truncated.
    expect(r.logs.length).toBeLessThan(big.length);
  });
});
