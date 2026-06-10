"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/** Selectable mono fonts (self-hosted; see styles/globals.css). */
export type FontChoice = "miosevka" | "jetbrains" | "nerdfont";

export const FONT_CHOICES: { id: FontChoice; label: string; description: string }[] = [
  { id: "miosevka", label: "Miosevka", description: "Curly Iosevka, sans serifs — the default" },
  { id: "jetbrains", label: "JetBrains Mono", description: "Familiar, wide coding mono" },
  {
    id: "nerdfont",
    label: "JetBrains Mono Nerd Font",
    description: "Coding ligatures + Nerd Font icon glyphs",
  },
];

/** Parse a cookie/localStorage value into a known FontChoice (Miosevka default). */
export function parseFontChoice(value: string | null | undefined): FontChoice {
  return value === "jetbrains" || value === "nerdfont" ? value : "miosevka";
}

/** Cookie the server reads in layout.tsx to stamp the font class on <html>. */
export const FONT_COOKIE = "mca-font";

/** Class added to <html> per choice. Miosevka is the CSS default → no class. */
export const FONT_CLASS: Record<FontChoice, string> = {
  miosevka: "",
  jetbrains: "font-jetbrains",
  nerdfont: "font-nerd",
};

interface FontContextType {
  font: FontChoice;
  setFont: (font: FontChoice) => void;
}

const FontContext = createContext<FontContextType | undefined>(undefined);

export function FontProvider({
  children,
  initialFont,
}: {
  children: React.ReactNode;
  /** Font resolved on the server from the cookie; defaults to Miosevka. */
  initialFont?: FontChoice;
}) {
  const [font, setFontState] = useState<FontChoice>(initialFont ?? "miosevka");

  // Keep the <html> class in sync with the choice. The server already stamps
  // the correct class for the first paint (no flash); this handles later changes.
  useEffect(() => {
    const root = document.documentElement;
    for (const cls of Object.values(FONT_CLASS)) {
      if (cls) root.classList.remove(cls);
    }
    const cls = FONT_CLASS[font];
    if (cls) root.classList.add(cls);
  }, [font]);

  const setFont = useCallback((newFont: FontChoice) => {
    setFontState(newFont);
    // 1 year, lax — readable by the server on the next request.
    document.cookie = `${FONT_COOKIE}=${newFont}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  const value = useMemo(() => ({ font, setFont }), [font, setFont]);

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}

export function useFont() {
  const context = useContext(FontContext);
  if (!context) {
    throw new Error("useFont must be used within a FontProvider");
  }
  return context;
}
