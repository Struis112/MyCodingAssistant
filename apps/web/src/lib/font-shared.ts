// Server-safe font constants + utilities.
//
// Lives in a separate module from `font.ts` (which carries "use client" for the
// React Context Provider) so that the root layout — a server component —
// can call `parseFontChoice()` and read FONT_COOKIE/FONT_CLASS without
// tripping Next.js's "client function called from server" guard.
//
// Anything here MUST be free of React hooks, DOM APIs, and the
// "use client" directive. Pure types + constants + pure functions only.

/** Selectable mono fonts (self-hosted; see styles/globals.css). */
export type FontChoice = "miosevka" | "jetbrains" | "nerdfont";

/** Metadata shown in the font picker UI. Pure data — safe on the server. */
export const FONT_CHOICES: { id: FontChoice; label: string; description: string }[] = [
  { id: "miosevka", label: "Miosevka", description: "Curly Iosevka, sans serifs — the default" },
  { id: "jetbrains", label: "JetBrains Mono", description: "Familiar, wide coding mono" },
  {
    id: "nerdfont",
    label: "JetBrains Mono Nerd Font",
    description: "Coding ligatures + Nerd Font icon glyphs",
  },
];

/** Cookie name the server reads in layout.tsx to stamp the font class on <html>. */
export const FONT_COOKIE = "mca-font";

/** Class added to <html> per choice. Miosevka is the CSS default → no class. */
export const FONT_CLASS: Record<FontChoice, string> = {
  miosevka: "",
  jetbrains: "font-jetbrains",
  nerdfont: "font-nerd",
};

/**
 * Parse a cookie / localStorage value into a known FontChoice (Miosevka default).
 * Pure function: no DOM, no hooks — safe to call from a server component.
 */
export function parseFontChoice(value: string | null | undefined): FontChoice {
  return value === "jetbrains" || value === "nerdfont" ? value : "miosevka";
}
