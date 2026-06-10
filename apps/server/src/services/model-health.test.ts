import { describe, expect, it } from "vitest";
import { ModelHealth, MAX_STRIKES, SEED_QUARANTINE } from "./model-health.js";

describe("ModelHealth", () => {
  it("quarantines after MAX_STRIKES consecutive empty turns", () => {
    const h = new ModelHealth();
    expect(h.recordEmpty("m1")).toBe(false); // strike 1
    expect(h.isQuarantined("m1")).toBe(false);
    expect(h.recordEmpty("m1")).toBe(true); // strike 2 -> newly quarantined
    expect(h.isQuarantined("m1")).toBe(true);
    expect(h.recordEmpty("m1")).toBe(false); // already quarantined, not "newly"
  });

  it("a good turn clears the streak and the quarantine", () => {
    const h = new ModelHealth();
    for (let i = 0; i < MAX_STRIKES; i++) h.recordEmpty("m1");
    expect(h.isQuarantined("m1")).toBe(true);
    h.recordGood("m1");
    expect(h.isQuarantined("m1")).toBe(false);
    expect(h.recordEmpty("m1")).toBe(false); // streak restarted from zero
  });

  it("seeds start quarantined but can be cleared by a good turn", () => {
    const h = new ModelHealth(SEED_QUARANTINE);
    expect(h.isQuarantined("claude-opus-4-8")).toBe(true);
    h.recordGood("claude-opus-4-8");
    expect(h.isQuarantined("claude-opus-4-8")).toBe(false);
  });

  it("round-trips through a snapshot", () => {
    const h = new ModelHealth();
    h.recordEmpty("m1");
    h.recordEmpty("m1");
    const restored = new ModelHealth([], h.toJSON());
    expect(restored.isQuarantined("m1")).toBe(true);
    expect(restored.quarantinedIds()).toEqual(["m1"]);
  });
});
