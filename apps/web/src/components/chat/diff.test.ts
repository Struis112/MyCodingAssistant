import { describe, expect, it } from "vitest";
import { diffStats, parseDiff, toSplitRows } from "./diff";

// A representative display diff in the SDK's format: marker + padded line
// number + single space + content (width 2 here because max line num is 12).
const SAMPLE = [
  "  9 function greet(name) {",
  "-10   return 'hi ' + name;",
  "+10   return `hi ${name}`;",
  " 11 }",
].join("\n");

describe("parseDiff", () => {
  it("parses context, add and del rows with line numbers", () => {
    const rows = parseDiff(SAMPLE);
    expect(rows).toEqual([
      { type: "context", oldNum: 9, newNum: 9, text: "function greet(name) {" },
      { type: "del", oldNum: 10, text: "  return 'hi ' + name;" },
      { type: "add", newNum: 10, text: "  return `hi ${name}`;" },
      { type: "context", oldNum: 11, newNum: 11, text: "}" },
    ]);
  });

  it("preserves leading indentation in content", () => {
    const rows = parseDiff("+ 3     deeplyIndented();");
    expect(rows[0]).toEqual({ type: "add", newNum: 3, text: "    deeplyIndented();" });
  });

  it("keeps blank changed lines (empty content)", () => {
    const rows = parseDiff("+ 5 ");
    expect(rows[0]).toEqual({ type: "add", newNum: 5, text: "" });
  });

  it("collapses gap markers into a single gap row", () => {
    const rows = parseDiff([" 1 a", "   ...", "   ...", " 9 b"].join("\n"));
    expect(rows.map((r) => r.type)).toEqual(["context", "gap", "context"]);
  });

  it("ignores blank and unparseable lines", () => {
    expect(parseDiff("\n\ngarbage\n")).toEqual([]);
  });
});

describe("diffStats", () => {
  it("counts additions and deletions", () => {
    expect(diffStats(parseDiff(SAMPLE))).toEqual({ additions: 1, deletions: 1 });
  });
});

describe("toSplitRows", () => {
  it("pairs removed lines with added lines positionally", () => {
    const rows = parseDiff(SAMPLE);
    const split = toSplitRows(rows);
    expect(split).toEqual([
      {
        left: { num: 9, text: "function greet(name) {", kind: "context" },
        right: { num: 9, text: "function greet(name) {", kind: "context" },
      },
      {
        left: { num: 10, text: "  return 'hi ' + name;", kind: "del" },
        right: { num: 10, text: "  return `hi ${name}`;", kind: "add" },
      },
      {
        left: { num: 11, text: "}", kind: "context" },
        right: { num: 11, text: "}", kind: "context" },
      },
    ]);
  });

  it("emits one-sided rows when add/del counts differ", () => {
    const rows = parseDiff(["-1 old", "+1 new1", "+2 new2"].join("\n"));
    const split = toSplitRows(rows);
    expect(split).toEqual([
      { left: { num: 1, text: "old", kind: "del" }, right: { num: 1, text: "new1", kind: "add" } },
      { left: undefined, right: { num: 2, text: "new2", kind: "add" } },
    ]);
  });

  it("carries gap rows through", () => {
    const split = toSplitRows(parseDiff([" 1 a", "   ...", " 9 b"].join("\n")));
    expect(split[1]).toEqual({ gap: true });
  });
});
