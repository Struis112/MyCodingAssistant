Global rules from `~/AGENTS.md` still apply.

## Working rules

- no auto update of agents.md and claude.md without asking user

## Quick start (run it)

- Install: `npm install` (npm workspaces: `apps/web`, `apps/server`, `packages/shared`).
- Dev, hot-reload both: `npm run dev` → **API on :7641**, **web on :7642** (http://localhost:7642).
  - Web only `npm run dev:web` · server only `npm run dev:server` · supervised `npm run dev:supervised`.
- Checks: `npm run typecheck` · `npm run lint` (oxlint) · `npm test` (vitest) · `npm run format` (oxfmt).
- Map: `apps/web` (Next.js chat UI) · `apps/server` (API + PI SDK connector + ServiceSupervisor) · `packages/shared`.
- Theme + font are CSS-var + cookie driven and server-rendered in `app/layout.tsx` (no flash).
- Git: work happens on branch **`staging`**; an in-app commit-trigger may auto-commit WIP.

## Chat UI — recent work (context, don't re-derive)

- **Fonts** self-hosted in `apps/web/public/fonts/` (Miosevka + JetBrains Mono, woff2 + licenses).
  Switch in **Settings → Appearance → Font** via `lib/font.tsx` (cookie `mca-font`, `<html>` class
  `font-jetbrains`). Everything reads the `--font-mono` CSS var; Tailwind `mono` = `var(--font-mono)`.
  Coding ligatures + Miosevka cursive italics enabled in `globals.css`.
- **Themes**: Tokyo Night **Moon** (dark) / **Day** (light), both WCAG 2.2 AAA, in `globals.css` token
  blocks (`:root`, `.light`, `@media`). hljs tokens map to theme tokens (+ `--syntax-keyword` purple,
  `--syntax-type` teal). Uses the existing theme toggle.
- **UX**: composer auto-grow + `/` / Cmd·Ctrl+K focus + Esc blur (`Composer.tsx`); polite auto-scroll
  - “Jump to latest” (`ChatScreen.tsx`); Zustand `useShallow` selectors (perf); skip-link +
    `#main-content` + Alt+1..4 view switch (`AppShell.tsx`); removed colored message rails
    (`chat/items.tsx`); `aria-current="true"` (`Sidebar.tsx`).
- **Pending (#7)**: `@tanstack/react-virtual` is installed but the message list is **not** virtualized
  yet (ChatScreen renders all items). Wire it up when long sessions get slow.
- Usage indicator hydration mismatch fixed with a mounted gate — see the footgun section below.

## Footgun: SSR + hydration mismatches (Next.js App Router)

**Rule:** Never read `localStorage`, `sessionStorage`, `window`, `document`,
`navigator`, `Date.now()`, `Math.random()`, or anything else that differs
between server and client in:

- A Zustand store's initial state object
- A `useState(...)` initializer
- The render body of a Client Component

The server snapshot won't see the browser values, the client will, and React
throws a "Hydration failed" recoverable error on every page load. We've hit
this three times now:

- Voice-support hooks (`useSpeechRecognition`, `useSpeechSynthesis`)
- Theme initial state
- `currentModel` / `thinkingLevel` in the chat header

**Fix pattern:** initialize with an SSR-safe default, then hydrate from
the browser in a `useEffect` that runs once after mount.

```ts
// store.ts — SSR-safe defaults
currentModel: null,
thinkingLevel: "off",

// store.ts — helper that callers run after mount
export function readPersistedUserPrefs() {
  return {
    currentModel: readJSON<ModelInfo | null>("mca-model", null),
    thinkingLevel: readString("mca-thinking-level", "off"),
  };
}

// AppShell.tsx — hydration happens once
useEffect(() => {
  const prefs = readPersistedUserPrefs();
  if (prefs.currentModel) setCurrentModel(prefs.currentModel);
  if (prefs.thinkingLevel) setThinkingLevel(prefs.thinkingLevel);
}, []);
```

Side note: writing to `localStorage` from a setter is fine — setters only
run after a user interaction, never during SSR. The danger is _reading_
during render.

The one exception is the theme: it's set on `<html>` by an inline
synchronous script in `app/layout.tsx` before React hydrates, so the class
is already on the document when React's first render happens. Keep using
that pattern; don't switch the theme provider to read from localStorage
during its initial state.
