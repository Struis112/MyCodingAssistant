// Reverting an `edit` tool change.
//
// The Pi SDK applies edits straight to disk, so "keep the old version" means
// undoing an edit by reverse-applying its standard unified patch
// (`details.patch`). These are pure, dependency-free helpers so they can be
// unit-tested in isolation; the REST route in api/routes.ts does the file I/O.

import path from "node:path";

export interface Hunk {
  /** 1-based start line in the old (pre-edit) file. */
  oldStart: number;
  /** 1-based start line in the new (current, post-edit) file. */
  newStart: number;
  /** Context + removed lines = the OLD state we want to restore. */
  oldLines: string[];
  /** Context + added lines = the NEW state currently on disk. */
  newLines: string[];
}

export type RevertResult = { ok: true; text: string } | { ok: false; reason: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a standard unified patch into hunks. Header lines (---/+++) are ignored. */
export function parseUnifiedPatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number.parseInt(header[1], 10),
        newStart: Number.parseInt(header[3], 10),
        oldLines: [],
        newLines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // pre-hunk header lines

    const marker = line[0];
    const content = line.slice(1);
    if (marker === " ") {
      current.oldLines.push(content);
      current.newLines.push(content);
    } else if (marker === "-") {
      current.oldLines.push(content);
    } else if (marker === "+") {
      current.newLines.push(content);
    }
    // "\" (No newline at end of file) and anything else: ignored.
  }

  return hunks;
}

function arraysEqual(a: string[], b: string[], aStart: number): boolean {
  for (let i = 0; i < b.length; i++) {
    if (a[aStart + i] !== b[i]) return false;
  }
  return true;
}

/** Find every index where `block` occurs contiguously in `lines`. */
function findMatches(lines: string[], block: string[]): number[] {
  const matches: number[] = [];
  const limit = lines.length - block.length;
  for (let i = 0; i <= limit; i++) {
    if (arraysEqual(lines, block, i)) matches.push(i);
  }
  return matches;
}

/**
 * Reverse-apply `hunks` to `currentText` (the post-edit file), restoring the
 * pre-edit content. Each hunk's NEW block must still be present verbatim,
 * otherwise the whole revert fails (no partial writes) — this is what makes it
 * safe to call after the file may have changed.
 */
export function reverseApply(currentText: string, hunks: Hunk[]): RevertResult {
  if (hunks.length === 0) return { ok: false, reason: "Patch contained no hunks." };

  const { bom, text } = stripBom(currentText);
  const ending = detectLineEnding(text);
  const lines = normalizeToLF(text).split("\n");

  type Replacement = { start: number; deleteCount: number; insert: string[] };
  const replacements: Replacement[] = [];

  for (const hunk of hunks) {
    const hint = hunk.newStart - 1;

    if (hunk.newLines.length === 0) {
      // Pure deletion in the original edit: re-insert the old lines at the hint.
      if (hint < 0 || hint > lines.length) {
        return { ok: false, reason: "File no longer matches the change (offset out of range)." };
      }
      replacements.push({ start: hint, deleteCount: 0, insert: hunk.oldLines });
      continue;
    }

    const matches = findMatches(lines, hunk.newLines);
    if (matches.length === 0) {
      return {
        ok: false,
        reason: "File no longer matches the change — it may have been modified since.",
      };
    }
    // Prefer the match the patch points at; otherwise the one closest to it.
    const start = matches.includes(hint)
      ? hint
      : matches.reduce((best, m) => (Math.abs(m - hint) < Math.abs(best - hint) ? m : best));
    replacements.push({ start, deleteCount: hunk.newLines.length, insert: hunk.oldLines });
  }

  // Detect overlaps, then apply bottom-up so earlier indices stay valid.
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.start + prev.deleteCount > sorted[i].start) {
      return { ok: false, reason: "Overlapping changes — revert the most recent edit first." };
    }
  }

  const out = [...lines];
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    out.splice(r.start, r.deleteCount, ...r.insert);
  }

  return { ok: true, text: bom + restoreLineEndings(out.join("\n"), ending) };
}

/**
 * Resolve `p` against `root`, returning the absolute path only if it stays
 * inside `root` (defends against path traversal). Returns null otherwise, and
 * for `root` itself (a directory, never a file to revert).
 */
export function resolveWithinRoot(root: string, p: string): string | null {
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

// ----- line-ending / BOM helpers (mirror the SDK's edit tool behaviour) -----

export function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1 || crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}
