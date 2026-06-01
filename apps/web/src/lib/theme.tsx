"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "light" | "dark";

/** Cookie the server reads in layout.tsx to render the theme class on <html>. */
export const THEME_COOKIE = "mca-theme";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function readThemeCookie(): Theme | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  const value = match ? decodeURIComponent(match[1]) : null;
  return value === "light" || value === "dark" ? value : null;
}

function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: React.ReactNode;
  /** Theme resolved on the server from the cookie; undefined on first visit. */
  initialTheme?: Theme;
}) {
  // `explicit` = the user has made a choice (a cookie exists). When false, the
  // OS preference drives the colors via CSS `prefers-color-scheme`, and we must
  // NOT stamp a class onto <html> (doing so would override that media query).
  const explicit = initialTheme !== undefined;

  // Deterministic initial state for server + client first render (no mismatch).
  // For the no-cookie case we correct to the OS preference in an effect below.
  const [theme, setThemeState] = useState<Theme>(initialTheme ?? "dark");
  const [isExplicit, setIsExplicit] = useState<boolean>(explicit);

  // First-visit correction + keep in sync with OS preference until the user chooses.
  useEffect(() => {
    if (!readThemeCookie()) {
      setIsExplicit(false);
      setThemeState(systemTheme());
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (!readThemeCookie()) setThemeState(e.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Stamp the class on <html> only for an explicit choice. Otherwise leave the
  // element class-free so CSS `prefers-color-scheme` controls the colors.
  useEffect(() => {
    const root = document.documentElement;
    if (!isExplicit) {
      root.classList.remove("light", "dark");
      return;
    }
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme, isExplicit]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    setIsExplicit(true);
    // 1 year, lax — readable by the server on the next request.
    document.cookie = `${THEME_COOKIE}=${newTheme}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const value = useMemo(() => ({ theme, toggleTheme, setTheme }), [theme, toggleTheme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
