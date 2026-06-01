import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUnifiedPatch, resolveWithinRoot, reverseApply } from "./revert.js";

const OLD = "line1\nline2\nline3\nline4\nline5\n";
const NEW = "line1\nline2\nline3X\nline4\nline5\n";
const PATCH = [
  "@@ -1,5 +1,5 @@",
  " line1",
  " line2",
  "-line3",
  "+line3X",
  " line4",
  " line5",
  "",
].join("\n");

describe("parseUnifiedPatch", () => {
  it("splits context/removed/added lines into old and new blocks", () => {
    const [hunk] = parseUnifiedPatch(PATCH);
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.oldLines).toEqual(["line1", "line2", "line3", "line4", "line5"]);
    expect(hunk.newLines).toEqual(["line1", "line2", "line3X", "line4", "line5"]);
  });

  it("ignores ---/+++ headers and No-newline markers", () => {
    const patch = ["--- a/f", "+++ b/f", PATCH, "\\ No newline at end of file"].join("\n");
    expect(parseUnifiedPatch(patch)).toHaveLength(1);
  });

  it("returns [] for an empty patch", () => {
    expect(parseUnifiedPatch("")).toEqual([]);
  });
});

describe("reverseApply", () => {
  it("restores the original content from the post-edit content", () => {
    const result = reverseApply(NEW, parseUnifiedPatch(PATCH));
    expect(result).toEqual({ ok: true, text: OLD });
  });

  it("fails when the new block is no longer present (file changed since)", () => {
    const changed = "line1\nline2\nTOTALLY DIFFERENT\nline4\nline5\n";
    const result = reverseApply(changed, parseUnifiedPatch(PATCH));
    expect(result.ok).toBe(false);
  });

  it("preserves CRLF line endings", () => {
    const result = reverseApply(NEW.replace(/\n/g, "\r\n"), parseUnifiedPatch(PATCH));
    expect(result).toEqual({ ok: true, text: OLD.replace(/\n/g, "\r\n") });
  });

  it("preserves a leading BOM", () => {
    const result = reverseApply("\uFEFF" + NEW, parseUnifiedPatch(PATCH));
    expect(result).toEqual({ ok: true, text: "\uFEFF" + OLD });
  });

  it("applies multiple non-overlapping hunks", () => {
    const oldText = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const newText = "a\nB\nc\nd\ne\nf\nG\nh\n";
    const patch = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -6,3 +6,3 @@",
      " f",
      "-g",
      "+G",
      " h",
      "",
    ].join("\n");
    expect(reverseApply(newText, parseUnifiedPatch(patch))).toEqual({ ok: true, text: oldText });
  });

  it("returns ok:false for an empty hunk list", () => {
    expect(reverseApply(NEW, []).ok).toBe(false);
  });
});

describe("resolveWithinRoot", () => {
  const root = path.resolve("/project/root");

  it("resolves a path inside the root", () => {
    expect(resolveWithinRoot(root, "src/a.ts")).toBe(path.join(root, "src/a.ts"));
  });

  it("rejects path traversal", () => {
    expect(resolveWithinRoot(root, "../secret.txt")).toBeNull();
    expect(resolveWithinRoot(root, "../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute path outside the root", () => {
    expect(resolveWithinRoot(root, path.resolve("/etc/passwd"))).toBeNull();
  });

  it("accepts an absolute path inside the root", () => {
    const inside = path.join(root, "src/a.ts");
    expect(resolveWithinRoot(root, inside)).toBe(inside);
  });

  it("rejects the root itself", () => {
    expect(resolveWithinRoot(root, ".")).toBeNull();
  });
});
