Global rules from `~/AGENTS.md` still apply.

## Pi customizations live under `.pi/`
See `.pi/README.md` — settings, extensions, skills, prompts, themes.
- no auto update of agents.md and claude.md without asking user

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
run after a user interaction, never during SSR. The danger is *reading*
during render.

The one exception is the theme: it's set on `<html>` by an inline
synchronous script in `app/layout.tsx` before React hydrates, so the class
is already on the document when React's first render happens. Keep using
that pattern; don't switch the theme provider to read from localStorage
during its initial state.
