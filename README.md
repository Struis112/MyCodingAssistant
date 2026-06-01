# MyCodingAssistant

Local web chat UI on top of the Pi coding-agent SDK.

A Next.js + React frontend talks to an Express + Socket.IO backend which
wraps `@earendil-works/pi-coding-agent` in-process. Streaming text, thinking
blocks, and tool executions all render live in the chat. Sessions persist to
`~/.pi/agent/sessions/` so you can resume across server restarts.

## Tech

| Layer     | Choice                                             |
| --------- | -------------------------------------------------- |
| Frontend  | Next.js 15 (App Router), React 19, Tailwind CSS    |
| Backend   | Node.js 22+, Express, Socket.IO                    |
| AI core   | `@earendil-works/pi-coding-agent` (in-process SDK) |
| State     | Zustand                                            |
| Workspace | npm workspaces                                     |

## Run it

```bash
npm install
npm run dev          # starts server (:7641) and web (:7642)
```

Open <http://localhost:7642/>. Make sure you have an API key configured
either via `~/.pi/agent/auth.json` (run `pi /login`) or an env var like
`ANTHROPIC_API_KEY`.

### First-time setup (optional)

```bash
npm run setup       # one-time interactive setup
```

On Windows, the setup wizard offers to install MCA as a Windows Service so
the server + web auto-start on boot and stay up across restarts (requires an
elevated PowerShell — the wizard tells you how).

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

## Dependency hygiene

The repo runs two automations on top of the regular CI pipeline (in
`.github/workflows/ci.yml`):

- **`.github/dependabot.yml`** — Monday 06:00 UTC. Opens grouped PRs for
  minor + patch bumps (one PR for production deps, one for dev deps, one
  for GitHub Actions). Major bumps come as individual PRs. The Pi SDK
  itself is pinned to `latest` and intentionally ignored.
- **`.github/workflows/audit.yml`** — Monday 06:00 UTC, and also on every
  push or PR that touches a `package.json` / `package-lock.json`. Two-tier
  policy:
  - Production deps with high/critical advisories → **fails the run**.
  - Full tree (every severity, including dev deps) → informational only,
    rendered to the GitHub step summary alongside `npm outdated`.

The lockfile is the source of truth (`npm ci` is what CI uses; it fails on
any drift). If you need to force a transitive dep version because it can't
be reached through normal upgrades, add it to the root `package.json`
`overrides` block.

Run the same checks locally:

```bash
npm audit                            # full tree
npm audit --omit=dev --audit-level=high   # the gate that CI enforces
npm outdated                         # what's behind
```

## Theme

Light/dark, WCAG 2.2 AAA contrast. Defaults to OS preference, persists user
override in `localStorage`. The theme class is set by an inline
pre-hydration script in `layout.tsx` so there's no flash on first paint.
