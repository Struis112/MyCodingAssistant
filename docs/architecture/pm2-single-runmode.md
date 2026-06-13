# Refactor plan: one run mode, fully on PM2

Status: **PLAN — approved, not yet implemented.** Supersedes the run-mode
machinery in `run-mode.ts` and the NSSM coupling in `self-healing-deploy.md
§2a`.

**Confirmed decisions (2026-06-13):**

1. Single mode = built server + `next dev` web (don't block on the prod build).
2. Re-home the per-service repair hook into a PM2 monitor.
3. Boot persistence is **cross-platform** (Linux is a target): native PM2
   systemd on Linux; pm2-installer on Windows. See §5.
4. Run as a non-superuser: Windows → Administrator (not LocalSystem); Linux →
   a dedicated `mca` user.
5. Keep the deployer a separate PM2 app.
6. The deployer stops restarting web (Fast Refresh handles it); web restarts
   only on dependency/config changes.

**New requirement: cross-platform (Windows + Linux).** This is a reason FOR the
refactor — NSSM is the main Windows lock-in we're removing. See §5a.

## 1. Goal

Two simplifications, done together because they're entangled:

1. **One run mode.** Delete the `dev` / `hybrid` / `prod` distinction. There is
   exactly one way the stack runs, locally and "in production" (same machine
   today). No `/api/runmode`, no mode switcher card, no `appParametersFor`.
2. **Fully on PM2.** PM2 owns every process lifecycle. Remove NSSM and the
   custom `ServiceSupervisor` process-spawning role. Keep the _valuable_ bits
   that PM2 doesn't provide (idle-gated rebuild-restart, repair hook, healing
   feed) by re-homing them around PM2.

Non-negotiables carried over (AGENTS.md): hot-reload everything, self-healing
with the 50-restart / 60s policy, low cognitive load, WCAG AAA, and **never
restart mid-turn**.

## 2. The one run mode ("supervised")

Recommended definition — essentially today's `hybrid`, made the only mode:

| Process        | How it runs                                      | Hot-reload                                                       |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `mca-server`   | built: `node apps/server/dist/index.js`          | watcher rebuilds `dist` → **idle-gated** `pm2 reload mca-server` |
| `mca-web`      | `next dev -p 7642` (HMR)                         | native Fast Refresh — no restart needed                          |
| `mca-deployer` | built: `node apps/server/dist/start-deployer.js` | rebuilt on deploy like the server                                |

Why built-server + dev-web (not full prod):

- The production `next build` is **currently broken on this machine**
  (prerender InvariantError across 15.5.x/16/canary — environment bug, see
  the Next.js investigation). `next dev` is the only working web mode, so the
  single mode must use it until that's fixed.
- A built server gives stable, idle-gated restarts (never cuts a reply); `tsx
watch` restarted mid-turn, which is exactly what `hybrid` was created to
  avoid.

**Big simplification this unlocks:** because web is _always_ `next dev`, the
deployer no longer needs `webIsDevProfile()` or any "don't `next build` into a
live `.next`" guard — it never builds web at all. Web changes are picked up by
Fast Refresh automatically; the deployer only ever rebuilds/​restarts the
server. (`distDir` split `.next` vs `.next-prod` stays, harmlessly, for the
eventual prod flip.)

Future flip to true prod is a one-line change in the ecosystem config
(`next dev` → `next start`, `MCA_WEB_DEV=0`) once the build bug is fixed — but
it stays a config edit, **not** a reintroduced runtime "mode".

## 3. What happens to each current component

| Component                                                                          | Disposition                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/run-mode.ts` (RunMode, currentRunMode, appParametersFor, buildTargetFor) | **Delete.** + its test.                                                                                                                                                                                                                       |
| `/api/runmode` GET/POST (`index.ts`)                                               | **Delete.**                                                                                                                                                                                                                                   |
| Run-mode card + `/api/runmode` fetches (`ServicesView.tsx`)                        | **Delete** the card.                                                                                                                                                                                                                          |
| `start-prod.ts` (sets `MCA_SUPERVISE_WEB=1`)                                       | **Delete** — PM2 owns web.                                                                                                                                                                                                                    |
| `start-dev-supervised.ts`                                                          | **Delete** — superseded by `dist/index.js` under PM2.                                                                                                                                                                                         |
| `MCA_SUPERVISE_WEB` branch in `index.ts` + `createWebService`                      | **Delete** — PM2 supervises web, not the API.                                                                                                                                                                                                 |
| `watch-safe-restarter.ts` (+ tests)                                                | **Re-home** as the server's reload orchestrator (see §4). Keep the idle-gate + tsc-precheck logic; swap `process.exit(0)` for `pm2 reload mca-server`.                                                                                        |
| `ServiceSupervisor` (spawn/backoff/restart)                                        | **Demote.** PM2 does spawn/backoff/restart/boot. Keep `ServiceSpec.repair` hook + log buffer concepts, moved into a PM2-event monitor (§4).                                                                                                   |
| `ServiceRegistry` + Services screen                                                | **Keep, re-source.** Status/logs/uptime/restart now come from `pm2 jlist` / `pm2 logs` instead of in-proc supervisors. Self-reported entries stay.                                                                                            |
| `health-watchdog`, `healing-events`, `model-health`                                | **Keep** unchanged (they're transport-agnostic). Watchdog reads the re-sourced registry.                                                                                                                                                      |
| Deployer (`deploy-controller`, `git-known-good`, pipelines, `start-deployer.ts`)   | **Keep the control loop.** Replace NSSM activation (`nssm stop/start`, `webIsDevProfile`, `restartWebViaApi`) with `pm2 reload mca-server`. Web activation drops out entirely (Fast Refresh). Rollback's rescue-first git logic is unchanged. |
| `scripts/service/install-windows.ps1` + deployer install/uninstall                 | **Replace** with PM2 bring-up + a single boot shim (§5).                                                                                                                                                                                      |
| `backup-mca.ps1` (uses `Restart-Service`)                                          | **Update** any service control to `pm2` equivalents; backup content unchanged.                                                                                                                                                                |
| `ecosystem.config.cjs`                                                             | **Promote** to the source of truth (already scaffolded).                                                                                                                                                                                      |

## 4. Re-homing the self-healing pieces PM2 lacks

PM2 gives: autorestart, backoff, `max_restarts`, boot resurrection, log
capture, `jlist`/`describe` status. PM2 does **not** give: rebuild-before-
restart, idle-gating (don't restart mid-turn), or the log-inspecting `repair`
hook. Those move to two small in-process pieces:

1. **Reload orchestrator** (from `watch-safe-restarter`): watches
   `apps/server/dist`, debounces, runs `tsc --noEmit` precheck, waits for
   `activeTurnCount() === 0`, then `pm2 reload mca-server`. Records a healing
   event. This is the server's hot-reload.
2. **Repair monitor**: subscribes to PM2 events (`pm2.launchBus`) or polls
   `pm2 jlist`; on a crash-looping process it runs the existing `repair`-style
   log inspection + known-fix, records a healing event, and lets PM2 continue
   its restart cadence (or `pm2 restart` after a fix). Replaces
   `ServiceSupervisor`'s repair role; the `failed`/parked concept maps to PM2
   `stopped` after `max_restarts`.

Net: the Services screen and healing feed keep working; only the _mechanism_
under them changes from in-proc child processes to PM2-managed processes.

## 5. Boot persistence & service account (cross-platform)

PM2 keeps processes alive while the box is up. On reboot, an OS-level ignition
must start the PM2 daemon and run `pm2 resurrect` (which restores the list
written by `pm2 save`). The app layer is identical on both OSes — only this
ignition differs.

- **Linux (native, bulletproof):**

  ```
  pm2 start ecosystem.config.cjs && pm2 save
  pm2 startup systemd      # prints a sudo command; run it
  ```

  Generates a `pm2-<user>.service` systemd unit that runs `pm2 resurrect` on
  boot AND restarts the PM2 daemon itself if it dies. Nothing custom to write.

- **Windows (no native `pm2 startup`):** use **pm2-installer**, which installs
  the PM2 daemon as a Windows service (so the daemon self-heals too — matches
  our self-healing standard). Alternative: a Task Scheduler "At startup" task
  running `pm2 resurrect` as Administrator (minimal, but fires only once at
  boot — won't relaunch a crashed daemon mid-session).

Always `pm2 save` after the first `pm2 start` and after any change to the app
set.

**Service account (never a system superuser):**

- Windows: **Administrator** (not LocalSystem) — fixes the profile split + the
  over-privilege the eval flagged; `~/.pi/agent` becomes one profile.
- Linux: a dedicated **`mca`** user (not root) owning the repo, `~/.pm2`, and
  `~/.pi/agent`.

## 5a. Cross-platform inventory (what's still OS-specific)

The refactor removes the biggest Windows lock-in (NSSM). Remaining
OS-conditional pieces to port or guard:

| Artifact                                                | Today                         | Plan                                                                                                                         |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tools/nssm/nssm.exe` + `scripts/service/*-windows.ps1` | Windows-only install          | Delete (PM2 + §5 ignition replace them).                                                                                     |
| Deployer shelling to `nssm.exe`                         | Windows-only                  | Replaced by `pm2 reload` (cross-platform).                                                                                   |
| `scripts/backup/backup-mca.ps1` + backup task           | PowerShell                    | Add a parallel `backup-mca.sh` (+ cron/systemd-timer) for Linux; keep `.ps1` for Windows. Same git-bundle + state-zip logic. |
| LocalSystem profile paths                               | `C:\Windows\System32\...\.pi` | Gone once we run as Administrator/`mca` — single `~/.pi/agent`.                                                              |
| `ecosystem.config.cjs`                                  | already `path.join`-based     | Stays portable; no `.exe` assumptions.                                                                                       |
| Log rotation                                            | NSSM `AppRotateBytes`         | `pm2-logrotate` module (cross-platform) or ecosystem `max_size`.                                                             |

## 6. Phased migration (each phase reversible)

1. **Prove PM2 runs the stack** (no removals yet). Stop NSSM services, `npm run
pm2:start`, verify api 7641 / web 7642 / deployer, `pm2 save`. Confirm chat,
   reconnect, deploy-on-commit (with deployer pointed at `pm2 reload`) all work.
   Rollback = stop PM2, start NSSM.
2. **Re-home hot-reload & repair** (§4): land the reload orchestrator + repair
   monitor; verify a server edit triggers an idle-gated `pm2 reload` and a
   forced crash triggers repair + healing event.
3. **Switch the deployer to PM2 activation**: replace NSSM calls with
   `pm2 reload`; delete `webIsDevProfile`/web activation. Verify promote +
   rollback end-to-end.
4. **Delete run modes**: remove `run-mode.ts`, `/api/runmode`, the Services
   card, `start-prod.ts`, `start-dev-supervised.ts`, `MCA_SUPERVISE_WEB`,
   `MCA_WATCH_SAFE` env branches. Update tests.
5. **Boot shim + account** (§5): install `pm2 resurrect` ignition; switch to
   Administrator; remove the old NSSM service install scripts (keep uninstall
   temporarily for clean migration).
6. **Docs**: rewrite README "Run modes" → "How it runs (PM2)"; update
   `self-healing-deploy.md §2a`; note the prod-build flip path.

## 7. Risks & mitigations

- **PM2 on Windows boot reliability** → the §5 boot shim; verify across a real
  reboot before deleting NSSM.
- **Two restart authorities fighting** (PM2 autorestart + deployer + reload
  orchestrator) → single rule: **PM2 is the only thing that starts/stops
  processes.** The deployer and orchestrator only ever call `pm2 reload/
restart`; they never spawn. Idle-gate + deploy bounce-lock prevent overlap.
- **Losing in-proc log buffers** the Services screen reads → re-source from
  `pm2 logs --json` / log files before deleting `ServiceSupervisor`.
- **Deployer rebuilding the deployer** while it runs → already handled (own
  failure domain); under PM2 keep it a separate app and reload it last.
- **Reverting mid-migration** → phases 1–3 leave NSSM installable; don't run
  the uninstall scripts until phase 5 passes a reboot test.

## 8. Open questions — RESOLVED (2026-06-13)

All six confirmed; see the decisions block at the top. Summary: built-server +
`next dev` web (1); re-home repair into a PM2 monitor (2); cross-platform boot —
systemd on Linux, pm2-installer on Windows (3); non-superuser account —
Administrator/`mca` (4); deployer stays a separate PM2 app (5); deployer stops
touching web (6).

Remaining items to confirm at execution time (not blockers):

- Which OS is the _first_ migration target (Windows now, Linux later?).
- `pm2-logrotate` vs ecosystem `max_size` for log rotation.
