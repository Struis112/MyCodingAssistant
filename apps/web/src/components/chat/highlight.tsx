import type { ReactNode } from "react";
import { looksLikePath } from "./utils";

/**
 * Render a value string with any file/path-like tokens highlighted in a
 * prominent white, and everything else in `restClass`. Returns null when the
 * value contains no path-like token, so the caller can pick its own fallback.
 *
 * Used by ToolItem's collapsed-row preview to emphasise the file/path inside
 * a bash command or other tool argument.
 */
export function highlightImportant(value: string, restClass: string): ReactNode | null {
  if (!looksLikePath(value) && !value.split(/\s+/).some(looksLikePath)) return null;
  // Split on whitespace but keep the separators so spacing is preserved.
  return value.split(/(\s+)/).map((tok, i) =>
    /\S/.test(tok) && looksLikePath(tok) ? (
      <span key={i} className="text-foreground font-semibold">
        {tok}
      </span>
    ) : (
      <span key={i} className={restClass}>
        {tok}
      </span>
    ),
  );
}
