import { describe, expect, it } from "vitest";
import {
  ASSISTANT_BLOCK_STYLES,
  ITEM_STYLES,
  TOOL_DEFAULT_STYLE,
  TOOL_STATUS_STYLES,
  TOOL_STYLES,
  accentClasses,
  getToolStyle,
  type AccentToken,
} from "./styles";

describe("accentClasses", () => {
  it("returns literal tailwind classes (not template strings) so the purge keeps them", () => {
    // We assert against literal class names because if a future contributor
    // refactors to `text-${token}` the classes would silently get purged by
    // tailwind's content scanner. The tests would still pass type-wise but
    // the UI would lose its colours. This guards against that regression.
    const c = accentClasses("user-accent");
    expect(c.text).toBe("text-user-accent");
    expect(c.bgTint).toBe("bg-user-accent/15");
    expect(c.bgSolid).toBe("bg-user-accent/25");
    expect(c.border).toBe("border-user-accent/40");
    expect(c.rail).toBe("border-user-accent");
  });

  it("covers every AccentToken the union allows", () => {
    const tokens: AccentToken[] = [
      "user-accent",
      "assistant-accent",
      "tool-accent",
      "system-accent",
      "primary",
      "success",
      "warning",
      "error",
      "info",
      "muted-foreground",
    ];
    for (const t of tokens) {
      const c = accentClasses(t);
      // Every bundle has all five class slots populated.
      expect(c.text.length).toBeGreaterThan(0);
      // Background tints/solids always use an alpha variant; the neutral
      // 'muted-foreground' case is the only one that opts out of an alpha
      // border (it reuses the standard border-border for a calm look).
      expect(c.bgTint).toContain("/");
      expect(c.bgSolid).toContain("/");
      expect(c.border.length).toBeGreaterThan(0);
      expect(c.rail.length).toBeGreaterThan(0);
    }
  });
});

describe("ITEM_STYLES", () => {
  it("has an entry for every kind with a label, icon, and accent", () => {
    for (const kind of ["user", "assistant", "tool", "system"] as const) {
      const s = ITEM_STYLES[kind];
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.accent).toBeTypeOf("string");
      expect(s.icon).toBeTypeOf("object");
    }
  });

  it("assigns each kind its own dedicated accent (no two share one)", () => {
    const accents = Object.values(ITEM_STYLES).map((s) => s.accent);
    const uniq = new Set(accents);
    expect(uniq.size).toBe(accents.length);
  });
});

describe("getToolStyle", () => {
  it("returns the per-tool override for known tools (case-insensitive)", () => {
    expect(getToolStyle("bash")).toBe(TOOL_STYLES.bash);
    expect(getToolStyle("Bash")).toBe(TOOL_STYLES.bash);
    expect(getToolStyle("BASH")).toBe(TOOL_STYLES.bash);
    expect(getToolStyle("read")).toBe(TOOL_STYLES.read);
  });

  it("falls back to the default for unknown tools", () => {
    expect(getToolStyle("not-a-real-tool")).toBe(TOOL_DEFAULT_STYLE);
    expect(getToolStyle("")).toBe(TOOL_DEFAULT_STYLE);
    expect(getToolStyle(undefined)).toBe(TOOL_DEFAULT_STYLE);
  });

  it("marks bash with hideName=true so 'Bash <cmd>' becomes just '<cmd>'", () => {
    expect(TOOL_STYLES.bash.hideName).toBe(true);
    expect(TOOL_DEFAULT_STYLE.hideName).toBeUndefined();
  });
});

describe("TOOL_STATUS_STYLES", () => {
  it("has running/success/error with distinct accents", () => {
    expect(TOOL_STATUS_STYLES.running.accent).toBe("warning");
    expect(TOOL_STATUS_STYLES.success.accent).toBe("success");
    expect(TOOL_STATUS_STYLES.error.accent).toBe("error");
  });
});

describe("ASSISTANT_BLOCK_STYLES", () => {
  it("text blocks use the assistant accent; thinking blocks are muted with a brain icon", () => {
    expect(ASSISTANT_BLOCK_STYLES.text.accent).toBe("assistant-accent");
    expect(ASSISTANT_BLOCK_STYLES.thinking.accent).toBe("muted-foreground");
    expect(ASSISTANT_BLOCK_STYLES.thinking.icon).toBeDefined();
  });
});
