// Small string / data helpers used by the chat renderer. Pure functions — no
// JSX, no React imports — so this module can be tested in isolation.

/**
 * The SDK's `edit` tool returns `details.diff` as a unified-style string:
 * each line prefixed with "+", "-", or " " and followed by a padded line
 * number. Pull that diff out, or return null when the result doesn't carry one.
 */
export function getToolDiff(result: unknown): string | null {
  if (result && typeof result === "object") {
    const details = (result as { details?: unknown }).details;
    if (details && typeof details === "object") {
      const diff = (details as { diff?: unknown }).diff;
      if (typeof diff === "string" && diff.trim()) return diff;
    }
  }
  return null;
}

/**
 * For file-based tools (Read/Edit/Write), pull the `path` arg apart into its
 * directory prefix and base file name. The UI keeps the full path visible
 * while highlighting just the file name segment. Returns null for tools that
 * don't operate on a path.
 */
export function toolFilePath(
  toolName: string | undefined,
  args: unknown,
): { dir: string; base: string } | null {
  const fileTools = new Set(["read", "edit", "write"]);
  if (!toolName || !fileTools.has(toolName.toLowerCase())) return null;
  if (!args || typeof args !== "object") return null;
  const path = (args as Record<string, unknown>).path;
  if (typeof path !== "string" || !path) return null;
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0
    ? { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) || path }
    : { dir: "", base: path };
}

/**
 * Whitespace-delimited token classifier: "looks like a path" if it has a slash
 * or ends in a short ".ext". Surrounding quotes/punctuation are stripped first
 * so `"foo.ts",` still matches.
 */
export function looksLikePath(token: string): boolean {
  const s = token.replace(/^["'(<]+|["',);>]+$/g, "");
  if (!s) return false;
  return /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

/**
 * Returns the first argument as `{ key, value }` with the value fully
 * stringified (not truncated). Truncation for display happens at render time
 * so the full value is always available via the title tooltip and the
 * expanded args pane.
 */
export function firstArg(args: unknown): { key: string; value: string } | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const key = Object.keys(obj)[0];
  if (!key) return null;
  const v = obj[key];
  return { key, value: typeof v === "string" ? v : safeStringify(v) };
}

/**
 * Truncate in the middle so the meaningful tail (e.g. a file name) stays
 * visible: `"C:/Users/…/message-preview.html"`.
 */
export function middleEllipsis(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - tail)}`;
}

/**
 * Derive a short, human-readable title from the persisted session file path.
 * Pi SDK names sessions like `2026-05-30T20-15-12-abc123.json`; strip the
 * extension and any leading timestamp prefix so the header stays readable.
 */
export function sessionTitle(sessionFile: string | undefined): string {
  if (!sessionFile) return "New chat";
  const base = sessionFile.split(/[\\/]/).pop() ?? sessionFile;
  const noExt = base.replace(/\.json$/i, "");
  // Drop ISO-ish timestamp prefix (e.g. "2026-05-30T20-15-12-") if present.
  const trimmed = noExt.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+-/, "");
  return trimmed || noExt || "Session";
}

export function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(r.content)) {
      return r.content
        .map((c) => (c.type === "text" && c.text ? c.text : safeStringify(c)))
        .join("\n");
    }
  }
  return safeStringify(result);
}
