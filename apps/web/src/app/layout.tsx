import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ThemeProvider, THEME_COOKIE, type Theme } from "@/lib/theme";
import { FontProvider, FONT_COOKIE, type FontChoice } from "@/lib/font";
import { SWRProvider } from "@/lib/swr-provider";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "MyCodingAssistant",
  description: "Self-learning AI coding assistant",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve the theme on the server from a cookie. When present, we render the
  // matching class on <html> directly, so the markup is fully deterministic —
  // no pre-hydration script and no flash. When absent (first visit), we render
  // no class and let CSS `prefers-color-scheme` pick the colors (see globals.css).
  const jar = await cookies();
  const stored = jar.get(THEME_COOKIE)?.value;
  const theme: Theme | undefined = stored === "light" || stored === "dark" ? stored : undefined;

  // Mono font choice (Miosevka default). Stamp the class on <html> server-side
  // so the first paint already uses the chosen font — no flash, same as theme.
  const storedFont = jar.get(FONT_COOKIE)?.value;
  const font: FontChoice = storedFont === "jetbrains" ? "jetbrains" : "miosevka";
  const htmlClass =
    [theme, font === "jetbrains" ? "font-jetbrains" : ""].filter(Boolean).join(" ") || undefined;

  return (
    <html lang="en" className={htmlClass} suppressHydrationWarning>
      {/* suppressHydrationWarning: tolerate attributes injected into <body> by
          browser extensions (Dark Reader, Grammarly/BIS, etc.) before React
          hydrates. It only covers <body>'s own attributes, not descendants. */}
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider initialTheme={theme}>
          <FontProvider initialFont={font}>
            <SWRProvider>{children}</SWRProvider>
          </FontProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
