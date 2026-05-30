# AGENTS.md — MyCodingAssistant (project)

This file is the project-level context that pi (and any other AGENTS.md-aware
agent) loads automatically when working inside this repo. Global rules in
`~/AGENTS.md` still apply; this file *adds* project-specific guidance.

## Project shape

- npm workspaces monorepo. Workspaces: `apps/*`, `packages/*`.
- Apps:
  - `apps/server` — Express + Socket.IO backend, wraps `@earendil-works/pi-coding-agent` for the LLM via the in-process SDK (`src/services/pi-session.ts`). Default port: `3001`.
  - `apps/web` — Next.js 15 frontend on port `3000`. Light/dark theme via `src/lib/theme.tsx`; the theme class is set pre-hydration in `src/app/layout.tsx`.
- Packages live under `packages/` (avatar-3d, face-detection, learning-service, llm-service, object-detection, service-manager, shared, stt-service, tts-service).

## Commands

| Task | Command |
|------|---------|
| Install all deps | `npm install` (root) |
| Dev (server + web) | `npm run dev` |
| Server only | `npm run dev:server` |
| Web only | `npm run dev:web` |
| Build everything | `npm run build` |
| Lint | `npm run lint` |
| Test | `npm run test` |
| Launch pi in repo | `npm run pi` |

## Conventions (inherited + extended)

From the global AGENTS.md (still apply):
- Use the `gh` CLI for all GitHub repo operations.
- Default branch is `main`.
- Semantic versioning + Conventional Commits.
- Pull latest stable versions from the internet, don't pin guesses.

Project-specific:
- TypeScript everywhere. Modules are ESM (`"type": "module"` in workspaces).
- Node `>=22`, npm `>=10` (see root `engines`).
- Don't import across workspaces by relative path — use the workspace package name (e.g. `@mca/shared`).
- Frontend default theme is **dark**. Theme preference persists under `localStorage` key `mca-theme`.
- Server reads `PORT` and `HOST` env vars; web reads `NEXT_PUBLIC_*` only.

## Pi customizations in this repo

Project-level pi resources live under `.pi/`:

- `.pi/settings.json` — project pi settings (auto-loaded).
- `.pi/extensions/` — TypeScript pi extensions auto-discovered at startup.
- `.pi/skills/` — `/skill:<name>` capabilities.
- `.pi/prompts/` — `/<name>` prompt templates.
- `.pi/themes/` — custom TUI themes.

See `.pi/README.md` for what's in each.
