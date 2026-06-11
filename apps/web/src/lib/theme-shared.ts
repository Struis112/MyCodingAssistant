// Theme constants + parsing WITHOUT "use client", so the server component in
// layout.tsx can call parseTheme() to stamp the right class on <html> for a
// flash-free first paint. Same rationale as font-shared.ts: importing a
// callable from a "use client" module into a server component makes it a
// client reference, which can't be invoked during SSR.

export type Theme = "light" | "dark" | "shadcn-light" | "shadcn-dark";

/** Cookie the server reads in layout.tsx to render the theme class on <html>. */
export const THEME_COOKIE = "mca-theme";

export const THEMES: readonly Theme[] = ["dark", "light", "shadcn-dark", "shadcn-light"];

/** Validate a cookie value; anything unknown means "no explicit choice". */
export function parseTheme(value: string | null | undefined): Theme | undefined {
  return (THEMES as readonly string[]).includes(value ?? "") ? (value as Theme) : undefined;
}

/** The light/dark counterpart within the same theme family (for the toggle). */
export function oppositeTheme(theme: Theme): Theme {
  switch (theme) {
    case "dark":
      return "light";
    case "light":
      return "dark";
    case "shadcn-dark":
      return "shadcn-light";
    case "shadcn-light":
      return "shadcn-dark";
  }
}
