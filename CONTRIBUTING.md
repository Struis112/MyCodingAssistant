# Contributing to MyCodingAssistant

Thanks for being here. This document covers how the project is structured,
the local dev workflow, and the conventions PRs need to follow before they
get merged.

## TL;DR

```bash
git clone https://github.com/Struis112/MyCodingAssistant.git
cd MyCodingAssistant
npm install                # installs husky pre-commit hooks too
npm run dev                # starts server (:3001) + web (:3000)
```

Open <http://localhost:3000/>.

## Tooling

| Concern | Tool | Command |
|---|---|---|
| Lint | [oxlint](https://oxc.rs) | `npm run lint` / `npm run lint:fix` |
| Format | [oxfmt](https://oxc.rs) | `npm run format` / `npm run format:check` |
| Typecheck | TypeScript | `npm run typecheck` |
| Unit tests | [Vitest](https://vitest.dev) | `npm test` / `npm run test:coverage` |
| E2E tests | [Playwright](https://playwright.dev) | `npm run test:e2e` |
| Git hooks | [husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged) | runs automatically |
| Coverage report | [Codecov](https://codecov.io) | uploaded by CI |

A pre-commit hook formats and lints only the files you staged. To bypass it
in an emergency: `git commit --no-verify`.

## Branching & commits

- **Default branch**: `main`. Direct pushes are blocked; merge via PR.
- **Branch names**: `<type>/<short-description>` (`feat/voice-input`,
  `fix/hydration-race`, `chore/upgrade-next`, `docs/contributing`).
- **Commit messages**: [Conventional Commits](https://www.conventionalcommits.org/).
  Examples:
  - `feat(chat): add markdown rendering for assistant blocks`
  - `fix(ws): emit chat:done via io to survive tab reloads`
  - `refactor: drop unused tts/stt service workers`
  - `chore(deps): bump next to 15.5`
  - `docs: rewrite CONTRIBUTING with the new tooling stack`
- **Versioning**: [Semantic Versioning](https://semver.org/). Released via
  tags on `main`.

## Pull request checklist

Before opening a PR, please make sure:

- [ ] `npm run lint` is clean
- [ ] `npm run format:check` is clean (the pre-commit hook handles this for you)
- [ ] `npm run typecheck` is clean
- [ ] `npm test` passes
- [ ] `npm run test:e2e` passes (one-time: `npx playwright install chromium`)
- [ ] `npm run build` succeeds
- [ ] If you touched the Pi SDK integration, you re-read the
      ["Pi SDK footguns" section in AGENTS.md](./AGENTS.md)

CI will run lint, typecheck, tests with coverage, build, Playwright e2e,
and a Docker image build. PRs that turn CI red won't be reviewed until
they're green.

> **Format-check is not in CI yet.** oxfmt 0.52 produces slightly different
> output on Linux vs Windows for the same input (line-wrap thresholds in JSX
> text, indentation inside nested try/catch). Until that settles, the
> pre-commit hook is the source of truth for formatting. Run
> `npm run format` before committing if you've been bypassing the hook.

## Architecture quick tour

The full layout lives in [AGENTS.md](./AGENTS.md). In short:

- `apps/server` — Express + Socket.IO, wraps `@earendil-works/pi-coding-agent`
  in-process. **The Pi SDK is a library, not a network service.** Don't try
  to split it into a worker process.
- `apps/web` — Next.js 15 (App Router) + Tailwind + Zustand. The root `/`
  renders the app directly — there is no marketing/landing page and no
  `/app` sub-route.
- `packages/shared` — TS interfaces shared across apps.

## Auto-deploy

Tagged releases (`vX.Y.Z`) trigger a Docker image build and push to GitHub
Container Registry at `ghcr.io/struis112/mycodingassistant`. Pull and run:

```sh
docker run --rm -it \
  -p 3000:3000 -p 3001:3001 \
  -v ~/.pi/agent:/data/pi \
  ghcr.io/struis112/mycodingassistant:latest
```

The bind mount is important: it keeps your sessions + auth on the host
between container restarts.

## Reporting issues

When filing a bug, please include:
- OS + browser + Node version
- The 20 lines of `[MCA Server]` log around the failure
- What you typed / clicked when it broke
- Whether you can reproduce after `Ctrl+Shift+R` and `New Chat`
