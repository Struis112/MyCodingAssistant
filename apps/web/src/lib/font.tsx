"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
// Server-safe primitives live in font-shared.ts (no "use client") so the
// root layout — a server component — can call parseFontChoice() without
// tripping the Next.js "client function called from server" guard. We
// re-export them here so existing client code that imports from
// "@/lib/font" keeps working unchanged.
import {
  FONT_CHOICES,
  FONT_CLASS,
  FONT_COOKIE,
  parseFontChoice,
  type FontChoice,
} from "./font-shared";
export { FONT_CHOICES, FONT_CLASS, FONT_COOKIE, parseFontChoice };
export type { FontChoice };

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
