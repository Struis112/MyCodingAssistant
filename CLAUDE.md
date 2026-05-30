# AGENTS.md — MyCodingAssistant

Project-level context for any AGENTS.md-aware agent (pi, Claude Code, etc.).
Loaded automatically when working inside this repo. Global rules in
`~/AGENTS.md` still apply; this file *adds* project-specific guidance.

If you're Claude Code: there's a matching `CLAUDE.md` with identical content
so you get the same context — please read it.

## What this repo is

A small, local web chat UI on top of the Pi coding-agent SDK. That's it.

- **Backend** (`apps/server`): Express + Socket.IO that wraps
  `@earendil-works/pi-coding-agent` in-process via `PiSessionManager`. It
  exposes one REST surface and one WebSocket surface for the browser.
- **Frontend** (`apps/web`): Next.js 15 + React 19 + Tailwind + Zustand.
  Three views (Chat, Sessions, Settings) behind a sidebar. Streams text,
  thinking blocks, and tool executions live.
- **Shared types** (`packages/shared`): a handful of TS interfaces shared
  across apps. Nothing else lives under `packages/`.

The Pi SDK runs **in the same Node.js process** as the server — there are
no separate worker processes or microservices. An earlier iteration of this
repo had TTS/STT/face-detection/object-detection/avatar workers; those
were all deleted because the SDK is a library, not a network service.

## Project shape

```
.
├── apps/
│   ├── server/                      Express + Socket.IO + Pi SDK
│   │   └── src/
│   │       ├── index.ts             entry point, http + ws bootstrap
│   │       ├── services/
│   │       │   └── pi-session.ts    PiSessionManager wrapping the SDK
│   │       ├── websocket/
│   │       │   └── handlers.ts      chat:* + session:* event handlers
│   │       └── api/
│   │           └── routes.ts        REST: /api/models, /api/sessions
│   └── web/                         Next.js 15 frontend
│       └── src/
│           ├── app/                 layout (pre-hydration theme script) + root page
│           ├── components/
│           │   ├── AppShell.tsx     sidebar + main view router
│           │   ├── ChatScreen.tsx   text + thinking + tool-call rendering
│           │   ├── SessionsView.tsx persisted session list
│           │   ├── Settings.tsx     model picker, thinking level, theme toggle
│           │   ├── Sidebar.tsx      three-item nav
│           │   └── ThemeToggle.tsx  light/dark switch button
│           ├── hooks/
│           │   ├── useSpeechRecognition.ts   mic input (Web Speech API)
│           │   └── useSpeechSynthesis.ts     auto-speak (speechSynthesis)
│           └── lib/
│               ├── store.ts         Zustand global state
│               ├── socket.ts        socket.io-client singleton
│               ├── theme.tsx        theme context + provider
│               └── utils.ts         cn(), formatTimestamp, etc.
├── packages/
│   └── shared/                      shared TS types (SessionInfo, ModelInfo, etc.)
├── .pi/                             project-level pi config (see .pi/README.md)
├── AGENTS.md                        this file
├── CLAUDE.md                        identical copy for Claude Code
└── README.md                        human-readable overview
```

## Commands

| Task | Command |
|------|---------|
| Install all deps | `npm install` (root) |
| Dev (server + web) | `npm run dev` |
| Server only | `npm run dev:server` |
| Web only | `npm run dev:web` |
| Build everything | `npm run build` |
| Lint | `npm run lint` |
| Test | `npm test` |
| Format | `npm run format` |
| Launch pi in repo | `npm run pi` (or just `pi`) |

Server: <http://localhost:3001>. Web: <http://localhost:3000>.
The web app is served at `/` — there is no `/app` route.

## Conventions

From the global `~/AGENTS.md` (still apply here):
- Use the `gh` CLI for all GitHub repo operations.
- Default branch is `main`.
- Semantic versioning + Conventional Commits.
- Pull latest stable versions from the internet, don't pin guesses.

Project-specific:
- **TypeScript everywhere.** Modules are ESM (`"type": "module"` in workspaces).
- **Node `>=22`, npm `>=10`** (see root `engines`).
- **Cross-workspace imports** must use the package name (e.g. `@mca/shared`),
  not relative paths.
- **Frontend theme**: dark by default; OS preference detected at first load;
  user override persists under `localStorage` key `mca-theme`. The theme
  class is set by an inline pre-hydration script in `apps/web/src/app/layout.tsx`
  so there's no flash on first paint. Colors meet WCAG 2.2 AAA contrast.
- **State on the frontend**: Zustand. Single store, defined in `apps/web/src/lib/store.ts`.
  Don't introduce Redux/React Query/etc. unless there's a strong reason.
- **Chat items model**: messages are not a flat string array — they're a
  `ChatItem` union of `user | assistant | tool | system`. Assistant items
  hold `ContentBlock[]` (text + thinking). Tool items render expandable
  cards with status/args/result. See `apps/web/src/lib/store.ts`.
- **WebSocket lifecycle events** (`chat:done`, `chat:error`, `chat:aborted`,
  `chat:queued`) must use `io.emit` (broadcast to all sockets) so a tab reload
  mid-stream doesn't strand the UI on "Streaming..." forever.

## Pi SDK integration ground rules

When touching `apps/server/src/services/pi-session.ts` or
`apps/server/src/websocket/handlers.ts`:

- Sessions are persistent — `SessionManager.create(cwd)` writes to
  `~/.pi/agent/sessions/`. Never silently switch to `inMemory()`.
- `session.setModel(model)` requires the **full Model object** from
  `modelRegistry.find(provider, modelId)`. Don't fake it by passing
  `{ id, name, provider }` literals — the SDK will reject it.
- Every SDK event (text deltas, thinking deltas, tool executions, queue
  updates, compaction, retries) gets forwarded as `chat:event` so the
  frontend can render it. Don't filter on the server.
- If you add a new chat-lifecycle event (e.g. `chat:foo`), use `io.emit`,
  not `socket.emit`, so reloaded tabs still receive it.

## What's NOT in this repo

If you find yourself missing something, it's probably because we removed it:

- ❌ No service manager / no spawned worker processes
- ❌ No TTS/STT worker services (browser-native speech APIs only)
- ❌ No face/object detection, webcam access, 3D avatar
- ❌ No logs viewer, no service dashboard
- ❌ No marketing/landing page — the app is the root URL

Don't reintroduce these without a specific user request.

## Pi customizations in this repo

Project-level pi resources live under `.pi/`:

- `.pi/settings.json` — project pi settings (theme, queue modes, telemetry off)
- `.pi/extensions/` — TypeScript pi extensions auto-discovered at startup
- `.pi/skills/` — `/skill:<name>` capabilities
- `.pi/prompts/` — `/<name>` prompt templates
- `.pi/themes/` — custom TUI themes (none yet)

See `.pi/README.md` for the contents and how to add more.
