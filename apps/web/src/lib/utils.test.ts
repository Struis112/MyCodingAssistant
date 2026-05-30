import { describe, expect, it } from "vitest";
import { cn, formatTimestamp, generateId } from "./utils";

describe("cn", () => {
  it("joins multiple class strings", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });

  it("honors conditional object form", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("merges conflicting tailwind classes (last one wins)", () => {
    // tailwind-merge collapses competing utilities in the same family.
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });
});

describe("formatTimestamp", () => {
  it("returns a non-empty string for a valid timestamp", () => {
    const out = formatTimestamp(Date.UTC(2024, 0, 1, 12, 30, 45));
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("includes seconds (HH:MM:SS shape)", () => {
    const out = formatTimestamp(Date.UTC(2024, 0, 1, 12, 30, 45));
    // We don't pin the locale-specific separator, just verify two ':' chars
    // are present (i.e. HH:MM:SS or HH:MM:SS am).
    const colons = (out.match(/:/g) || []).length;
    expect(colons).toBe(2);
  });
});

describe("generateId", () => {
  it("returns a non-empty string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns unique values across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateId());
    // Collisions are theoretically possible but extremely unlikely;
    // > 990/1000 unique is a fine sanity check for randomness.
    expect(ids.size).toBeGreaterThan(990);
  });
});
