- Chat uses PI SDK with streaming text (codeblocks, reasoning and all other info)
- Frontend is Next.js and React (Idiomatically)
- light/dark theme with WCAG 2.2 AAA contrast.
- Don't add features I didn't ask for, but always **suggest better options and improvements**
- **Cross-platform: Windows AND Linux.** No OS-locked assumptions in app code (use `node:path`, no `.exe`/shell-builtin assumptions). Only the boot ignition differs per OS (see Process management).

## Project-wide standards (apply by default to every new screen, function, and service)

### Cognitive load

- Every screen and piece of text must be **easy on cognitive load**: short, plain-language status lines; one clear primary action per view; progressive disclosure (details on demand, not all at once); calm, consistent status colors at WCAG 2.2 AAA contrast.

### Process management & run mode (PM2)

- **All services run under PM2**, defined in `ecosystem.config.cjs`: `mca-server` (API + WebSocket, built `dist/index.js`), `mca-web` (Next.js), `mca-deployer` (deploy controller). PM2 owns process lifecycle — spawn, crash-restart with backoff, boot resurrection. New long-running services are added as PM2 apps there.
- **One run mode** (no more dev/hybrid/prod): built server + web `next dev` (HMR). Flipping web to a true prod build is a config change (`MCA_WEB_DEV=0`, `next start`) once the Next prod-build bug is fixed — not a runtime "mode".
- **Restart policy (mirror everywhere):** `max_restarts: 50`, `restart_delay: 60_000` (retry once/min), `min_uptime: 30s`, `fork`/single instance (the WebSocket server is stateful — **never cluster**). Mirrors `DEFAULT_MAX_RESTARTS = 50` / `DEFAULT_RESTART_INTERVAL_MS = 60_000`.
- **Hot-reload everything:** web via `next dev` Fast Refresh; server via the reload orchestrator (watch `dist` → `tsc` precheck → **idle-gated** `pm2 reload`, never mid-turn — gate on `activeTurnCount() === 0`).
- **Boot persistence / account:** Linux → native `pm2 startup systemd` + `pm2 save`; Windows → `pm2-installer` (daemon as a service) + `pm2 save`. Run as a **non-superuser**: Windows **Administrator** (not LocalSystem), Linux a dedicated **`mca`** user (not root).
- See `docs/architecture/pm2-single-runmode.md` (design) and `pm2-cutover-runbook.md` (ops). **Migration status:** Phase 1 cutover done (server+web on PM2); deployer→`pm2 reload` (Phase 3), reload orchestrator (Phase 2), run-mode deletion (Phase 4), boot persistence (Phase 5) in progress. NSSM is being retired (it was the main Windows lock-in).

### Service inventory (Services screen)

- Every long-running service appears on the **Services screen** with live status, uptime, port, restart count, recent logs, and a manual start/stop/restart control — sourced from `pm2 jlist`.

### Self-repair & self-healing visibility

- PM2 auto-restarts crashed processes (50/60s cap, then parked for manual start). The log-inspecting **repair hook** (read recent logs → known fix → restart) is re-homed into a PM2 monitor.
- **Self-healing events** (deploy promote/rollback/park, crash-restarts, model quarantine) are recorded (`healing-events`) and shown in the Services-screen feed — make self-healing visible, never silent.

### Deploy safety (the deployer is destructive if careless)

- Git-anchored: `live` ref = last known-good; per commit: build → validate → activate (`pm2 reload`) → verify → **promote**, else **PARK** (live stays on known-good, work preserved).
- **Rescue-first rollback — never destroy work:** before any reset, orphanable commits go to a `rescue/<ts>` branch and dirty tracked files are stashed. Never blind `git reset --hard` over uncommitted or committed-but-unpromoted work.
- **Never roll back on a broken build ENVIRONMENT** (missing toolchain — "Cannot find module", ENOENT, "command not found"): PARK without touching git (`build_env`). A missing tool isn't a bad commit.
- **One deployer at a time;** PM2 is the only thing that starts/stops app processes — the deployer + orchestrator only ever call `pm2 reload/restart`.

### Security & access

- The agent executes shell commands with the service's privileges, so the app must **not** be openly reachable. **LAN access gate:** non-loopback requests need the shared key (`logs/mca-access-key.txt` or `MCA_ACCESS_KEY`), enforced on HTTP + the socket handshake; the web client attaches it automatically. Firewall scoped to `LocalSubnet`.

### Durability

- **Never run `npm install` with `NODE_ENV=production`** — it prunes devDependencies (typescript/vitest/oxlint) and silently breaks every build (caused a destructive rollback loop on 2026-06-13). `.npmrc` has `include=dev` to enforce this; don't remove it.
- **Nightly backup** (`scripts/backup/backup-mca.ps1` + scheduled task): git bundle of all refs + state zip (both profiles' `~/.pi/agent` + app state), 14-day retention. The git **bundle** is the offsite net when GitHub auth lapses.
- Pushes go through the `gh` credential helper (repo `credential.helper = !gh auth git-credential`) so they never hang on a prompt. Refresh an expired token with `gh auth login` / `gh auth refresh -h github.com -s repo`.

## Tooling

### GitHub browsing (read-only)

- A project-local pi extension at `.pi/extensions/github.ts` registers a read-only `github` tool that wraps the authenticated `gh` CLI: list/search repos, read remote files without cloning, view issues/PRs. The machine's `gh` is logged in as `Struis112` (scopes: `repo`, `read:org`, `gist`).
- Auto-discovered from `.pi/extensions/`; run `/reload` to activate in a running session. `.pi/` is gitignored, so the file is tracked via `git add -f`.
- **Read-only by design** — no shell passthrough, no writes. For write operations (rename a repo, set branch protection, open a PR, etc.) call `gh` directly via bash.
