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

## Dependency hygiene & security

Four automations layered on top of the regular CI pipeline
(`.github/workflows/ci.yml`):

- **`.github/dependabot.yml`** — Monday 06:00 UTC. Opens grouped PRs split
  by update-type so patches and minors land separately:
  - `production-patch` / `development-patch`: patch-only bumps,
    auto-merged when green (see below).
  - `production-minor` / `development-minor`: minor bumps, always require
    a human review.
  - `ci-actions`: GitHub Actions updates in a single PR.
    Major bumps come as individual PRs. The Pi SDK itself tracks `latest`
    and is intentionally ignored.
- **`.github/workflows/auto-merge-dependabot.yml`** — on every Dependabot
  PR. Reads the update-type via `dependabot/fetch-metadata`. If it's
  patch-only, the workflow approves the PR and enables GitHub's native
  auto-merge (squash). Auto-merge only fires once every required check
  (CI verify, audit, CodeQL) is green; a red check holds the PR back.
  Minor and major PRs are left open for a human.
- **`.github/workflows/audit.yml`** — Monday 06:00 UTC, and also on every
  push or PR that touches a `package.json` / `package-lock.json`. Two-tier
  policy:
  - Production deps with high/critical advisories → **fails the run**.
  - Full tree (every severity, including dev deps) → informational only,
    rendered to the GitHub step summary alongside `npm outdated`.
- **`.github/workflows/codeql.yml`** — every push/PR against `main`, plus
  Monday 06:00 UTC. Static analysis for JS/TS source-level issues (taint
  flows, missing input validation, dangerous APIs). Findings show up
  under the repo's Security → Code scanning tab.

For auto-merge to function the repo needs:

- Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests" = ON.
- Settings → General → Pull Requests → "Allow auto-merge" = ON.
- Branch protection on `main` with the CI + audit + CodeQL checks listed
  as required (so the bot can't merge a red PR).

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
