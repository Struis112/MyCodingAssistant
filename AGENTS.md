- Chat uses PI SDK with streaming text (codeblocks, reasoning and all other info)
- Frontend is Next.js and React (Idiomatically)
- light/dark theme with WCAG 2.2 AAA contrast.
- Don't add features I didn't ask for, but always **suggest better options and improvements**

## Project-wide standards (apply by default to every new screen, function, and service)

### Cognitive load

- Every screen and piece of text must be **easy on cognitive load**: short, plain-language status lines; one clear primary action per view; progressive disclosure (details on demand, not all at once); calm, consistent status colors at WCAG 2.2 AAA contrast.

### Hot-reload (serve the latest version automatically)

- All services must **hot-reload**: a code change is served by the running service without manual rebuild/restart.
  - Dev: run under watch (`tsx watch` for the server, `next dev` for the web).
  - Supervised/prod: the `ServiceSupervisor` watches the service's source dirs and, on change, debounces → rebuilds → restarts so the latest build is always served.

### Service inventory

- Every long-running service must be registered in the **`ServiceRegistry`** (`apps/server/src/services/service-registry.ts`) so it appears in the **Services** screen with live status, uptime, port, restart count, recent logs, and a manual restart control.
- Services that can't supervise their own process (e.g. the API server) register as **self-reported** entries so they still show in the inventory.

### Self-repair (default restart policy)

- Supervised services are **self-repairing**: on an unexpected crash the supervisor inspects recent logs, attempts a known fix (`repair` hook), then restarts.
- **Restart policy defaults — use these for any new service: retry once per minute (`DEFAULT_RESTART_INTERVAL_MS = 60_000`) and a maximum of 50 attempts (`DEFAULT_MAX_RESTARTS = 50`).** After the cap the service is parked in `failed` (manual restart only). Don't override these without a stated reason.
- New supervised services are added via `new ServiceSupervisor(spec)` with a `repair` hook and `watch` config; the registry + Services screen pick them up automatically.

## Tooling

### GitHub browsing (read-only)

- A project-local pi extension at `.pi/extensions/github.ts` registers a read-only `github` tool that wraps the authenticated `gh` CLI: list/search repos, read remote files without cloning, view issues/PRs. The machine's `gh` is logged in as `Struis112` (scopes: `repo`, `read:org`, `gist`).
- Auto-discovered from `.pi/extensions/`; run `/reload` to activate in a running session. `.pi/` is gitignored, so the file is tracked via `git add -f`.
- **Read-only by design** — no shell passthrough, no writes. For write operations (rename a repo, set branch protection, open a PR, etc.) call `gh` directly via bash.

<!-- bootstrap-race verification ping 2026-06-10 — commit triggers the deploy
     gate with new lock+retry on both processes. Trivial; safe to revert. -->
