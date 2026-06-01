// Pure diff parsing for the JetBrains-style Diff viewer. No JSX / React here so
// it can be unit-tested in isolation.
//
// The SDK's `edit` tool returns `details.diff` as a display-oriented string
// (see edit-diff.ts -> generateDiffString). Each line has the shape:
//
//   "+<paddedNum> <content>"   an added line   (num = line in the NEW file)
//   "-<paddedNum> <content>"   a removed line  (num = line in the OLD file)
//   " <paddedNum> <content>"   a context line  (present in both)
//   " <pad> ..."               a skipped-context gap marker
//
// The line number is right-aligned (space-padded) to a constant width, then a
// single space separates it from the content. Content may itself begin with
// spaces (indentation), so we must not naively split on the first space.

/** One row of the diff in original order (drives the Unified view). */
export type DiffRow =
  | { type: "context"; oldNum: number; newNum: number; text: string }
  | { type: "add"; newNum: number; text: string }
  | { type: "del"; oldNum: number; text: string }
  | { type: "gap" };

export interface SplitCell {
  num: number;
  text: string;
  kind: "context" | "add" | "del";
}

/** One row of the Split (side-by-side) view. */
export type SplitRow = { gap: true } | { gap?: false; left?: SplitCell; right?: SplitCell };

export interface DiffStats {
  additions: number;
  deletions: number;
}

// marker, then padded number (leading spaces + digits), one space, then content.
const LINE_RE = /^([+\- ])( *\d+) (.*)$/;

/** Parse a display-diff string into ordered rows. Unparseable lines are skipped. */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.replace(/\n$/, "").split("\n");

  for (const line of lines) {
    if (line === "") continue;
    const marker = line[0];
    if (marker !== "+" && marker !== "-" && marker !== " ") continue;

    const rest = line.slice(1);
    // Gap marker: padding spaces followed by "...".
    if (/^ *\.\.\.$/.test(rest)) {
      // Collapse consecutive gaps into one.
      if (rows[rows.length - 1]?.type !== "gap") rows.push({ type: "gap" });
      continue;
    }

    const m = LINE_RE.exec(line);
    if (!m) continue;
    const num = Number.parseInt(m[2], 10);
    const text = m[3];
    if (marker === "+") rows.push({ type: "add", newNum: num, text });
    else if (marker === "-") rows.push({ type: "del", oldNum: num, text });
    else rows.push({ type: "context", oldNum: num, newNum: num, text });
  }

  return rows;
}

/**
 * Convert ordered rows into side-by-side rows. Within a change block, removed
 * lines are paired with added lines positionally (JetBrains-style); any surplus
 * on either side becomes a one-sided row.
 */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      out.push({ left: dels[i], right: adds[i] });
    }
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.type === "del") {
      dels.push({ num: row.oldNum, text: row.text, kind: "del" });
    } else if (row.type === "add") {
      adds.push({ num: row.newNum, text: row.text, kind: "add" });
    } else {
      flush();
      if (row.type === "gap") {
        out.push({ gap: true });
      } else {
        out.push({
          left: { num: row.oldNum, text: row.text, kind: "context" },
          right: { num: row.newNum, text: row.text, kind: "context" },
        });
      }
    }
  }
  flush();
  return out;
}

export function diffStats(rows: DiffRow[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    if (row.type === "add") additions++;
    else if (row.type === "del") deletions++;
  }
  return { additions, deletions };
}
