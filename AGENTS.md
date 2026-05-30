# AGENTS.md — MyCodingAssistant

Project-specific guidance only. Global rules from `~/AGENTS.md` still apply.
Defaults discoverable from `package.json`, `tsconfig.json`, or a quick `ls`
are deliberately omitted.

> CLAUDE.md is a byte-identical copy. Edit both together.

## Purpose

Local web chat UI on top of the Pi coding-agent SDK. Backend wraps
`@earendil-works/pi-coding-agent` **in-process** (it's a library, not a
network service). Frontend is Next.js. That's the whole product.

## Entry points

- `apps/server/src/index.ts` — http + ws bootstrap
- `apps/server/src/services/pi-session.ts` — `PiSessionManager` wrapping the SDK
- `apps/server/src/websocket/handlers.ts` — `chat:*` and `session:*` handlers
- `apps/web/src/app/page.tsx` — root URL renders `<AppShell />`
- `apps/web/src/components/AppShell.tsx` — sidebar + three-view router
- `apps/web/src/lib/store.ts` — Zustand store (canonical `ChatItem` shape lives here)

Web at `/` (no `/app` route). Server on `:3001`, web on `:3000`.

## Project-specific policies

- **State**: Zustand, single store in `apps/web/src/lib/store.ts`. Do not
  introduce Redux, React Query, etc. without a strong reason.
- **Theme**: light/dark with WCAG 2.2 AAA contrast. The class on `<html>` is
  set by an inline pre-hydration script in `apps/web/src/app/layout.tsx` so
  there's no flash. Don't move theme detection into `useEffect` only — it
  must run before React hydrates. Pref persists under `mca-theme` in
  `localStorage`.
- **Chat items are not strings**. Messages are a `ChatItem` union of
  `user | assistant | tool | system`. Assistant items hold `ContentBlock[]`
  (`text` + `thinking`). Tool executions are first-class items, not nested.
  See `apps/web/src/lib/store.ts`.

## Pi SDK footguns (in priority order)

1. **Chat lifecycle events use `io.emit`, never `socket.emit`.**
   `chat:done`, `chat:error`, `chat:aborted`, `chat:queued`. Reason: a tab
   reload mid-stream kills the original socket; if you `socket.emit` the
   completion, the reloaded tab never sees it and the UI sticks on
   "Streaming..." forever.
2. **`session.setModel()` needs the full `Model` object** from
   `modelRegistry.find(provider, modelId)`. Don't pass a hand-rolled
   `{ id, name, provider }`; the SDK rejects it.
3. **Sessions persist** via `SessionManager.create(cwd)`. Never silently
   switch to `inMemory()` — the user loses their history.
4. **Forward all SDK events untouched** as `chat:event`. Don't filter on
   the server. The frontend decides what to render.

## What's NOT in this repo (don't re-add without a request)

- No service manager, no spawned worker processes
- No TTS/STT worker services (browser Web Speech API only, in
  `apps/web/src/hooks/`)
- No face/object detection, webcam, 3D avatar
- No logs viewer, no service dashboard
- No marketing/landing page

## Pi customizations live under `.pi/`

See `.pi/README.md` — settings, extensions, skills, prompts, themes.
