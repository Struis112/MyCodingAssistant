# MyCodingAssistant

Local web chat UI on top of the Pi coding-agent SDK.

A Next.js + React frontend talks to an Express + Socket.IO backend which
wraps `@earendil-works/pi-coding-agent` in-process. Streaming text, thinking
blocks, and tool executions all render live in the chat. Sessions persist to
`~/.pi/agent/sessions/` so you can resume across server restarts.

## Tech

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind CSS |
| Backend | Node.js 22+, Express, Socket.IO |
| AI core | `@earendil-works/pi-coding-agent` (in-process SDK) |
| State | Zustand |
| Workspace | npm workspaces |

## Run it

```bash
npm install
npm run dev          # starts server (:3001) and web (:3000)
```

Open <http://localhost:3000/>. Make sure you have an API key configured
either via `~/.pi/agent/auth.json` (run `pi /login`) or an env var like
`ANTHROPIC_API_KEY`.

## Scripts

```bash
npm run dev          # server + web in parallel
npm run dev:server   # just the server
npm run dev:web      # just the web
npm run build        # build both
npm run lint
npm test
```

## Layout

```
apps/
  server/                Express + Socket.IO + Pi SDK wrapper
    src/services/pi-session.ts    AgentSession lifecycle
    src/websocket/handlers.ts     chat:send/abort/new/resume/list/state
    src/api/routes.ts             REST: models + sessions
  web/                   Next.js frontend
    src/app/             root layout + page (renders <AppShell/>)
    src/components/
      AppShell           sidebar + main view router
      ChatScreen         streaming chat with text + thinking + tool blocks
      SessionsView       persisted session list, click to resume
      Settings           model picker, thinking level, theme toggle
      Sidebar            three-item nav (chat / sessions / settings)
    src/hooks/           useModels (SWR-cached /api/models)
    src/lib/             store (Zustand), socket, theme, swr-provider, files, utils
packages/
  shared/                shared TS types
```

## Theme

Light/dark, WCAG 2.2 AAA contrast. Defaults to OS preference, persists user
override in `localStorage`. The theme class is set by an inline
pre-hydration script in `layout.tsx` so there's no flash on first paint.
