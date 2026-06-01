import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ThemeProvider, THEME_COOKIE, type Theme } from "@/lib/theme";
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
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme | undefined = stored === "light" || stored === "dark" ? stored : undefined;

  return (
    <html lang="en" className={theme} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider initialTheme={theme}>
          <SWRProvider>{children}</SWRProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
