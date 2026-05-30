import { ThemeProvider } from '@/lib/theme';
import type { Metadata } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'MyCodingAssistant',
  description: 'Self-learning AI coding assistant',
};

// Inline script: runs synchronously before React hydrates, sets the theme
// class on <html> based on localStorage or OS preference. This prevents both
// a flash of the wrong theme and the hydration mismatch warning.
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('mca-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
