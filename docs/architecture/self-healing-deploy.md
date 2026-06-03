# Self-Healing Deploy Loop (AI-authored changes)

Status: **Phase 1 done; Phase 2 code-complete (web-only) pending live debug + AI repair agent; Phases 3–4 designed**
Owner: MyCodingAssistant
Last updated: 2026-06-03

## 1. What we're building

A loop that lets the assistant (PI SDK agent) change the product and have the
change **go live automatically once it's developed**, with **automatic rollback**
when it doesn't work, and an **AI repair cycle** that reads the logs, tries
again, and keeps going until the system is stable.

In one line:

> AI edits → commit → build & validate → activate (hot-reload) → health-gate →
> **promote** if stable, else **roll back to last known-good**, feed the logs
> back to the AI, and retry — until stable or the time budget is spent.

This document is the agreed design. It is intentionally explicit about the
**failure domains**, **rollback guarantees**, and **safety rails**, because the
controller edits the very system it runs inside.

## 2. Goals / Non-goals

**Goals**

- Hot-reload _all_ elements (web, server, future services) from an AI change.
- A change only becomes "live/known-good" after it **builds, passes tests,
  restarts cleanly, and stays healthy for a stability window**.
- Automatic rollback to the last known-good version on any failed gate.
- AI repair loop: structured failure context → retry → until stable.
- Everything observable + controllable from the **Services** screen.

**Non-goals (explicitly out of scope for now)**

- Zero-downtime, in-flight LLM-turn handover between processes (not worth it;
  reconnect + disk session restore already covers continuity — see
  `handlers.ts` / session auto-restore).
- A bespoke generic process supervisor / service mesh / Kubernetes. Process
  keep-alive stays with the platform-native manager (NSSM on Windows, the
  container runtime in Docker) + the existing in-process `ServiceSupervisor`
  for local dev.
- Rolling back **data/state** (see §9 — code rollback ≠ data rollback).

## 3. Approved decisions (this iteration)

| Decision                        | Value                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deploy trigger                  | **Commit** ("change is done, deploy this"), not raw file-watch                                                                                                     |
| Initial scope                   | **web only**, then expand to `apps/*` + `packages/*`                                                                                                               |
| Off-limits to autonomous change | the **deployer** itself, **auth**, **install/service scripts**, **CI**                                                                                             |
| Repair-loop budget              | **8 hours wall-clock** per change-set (not work-time)                                                                                                              |
| On budget exhaustion            | **Ping the human + PARK**: live stays on known-good; candidate branch, attempt history and logs are **preserved** so the human can resume. Never discard the work. |
| Service identity                | Runs as **Administrator** (repo owner) — git identity blocker resolved.                                                                                            |
| Deployer process model          | **Separate process** under NSSM (not in-process).                                                                                                                  |
| Repair agent                    | **Dedicated headless PI SDK session hosted in the deployer process** — isolated from user chats and surviving the restarts it triggers.                            |

## 4. Architecture & failure domains

The single most important rule: **the thing that performs rollback must not
share a failure domain with the code it deploys.** If the AI breaks the server,
an in-process controller dies with it and can't recover. Therefore:

```
OS watchdog (NSSM / container runtime)
        │  keeps ONE tiny, rarely-changed thing alive
        ▼
   Deployer process  ("the conductor of deploys")
   - minimal deps, no chat/business logic
   - owns: git ref switch, build, restart, health-gate, promote/rollback
   - GUARDED: refuses to deploy changes touching off-limits paths
   - can roll back using only git + a restart (never depends on app health)
        │ supervises / promotes
        ├── web      (candidate → health-gated → promoted)
        ├── api      (candidate → health-gated → promoted)
        └── future services …
```

- **Deployer** = new, small, separate process. Kept alive by NSSM/runtime.
- **App services** (web, api, …) = supervised children, each satisfying the
  service contract (§6). These are the things that get hot-reloaded.
- The existing `ServiceSupervisor` / `ServiceRegistry` become the **local
  backend** the deployer drives; in containers the deployer drives the runtime.

## 5. The control loop (state machine)

Triggered when the AI signals "change complete" via a **commit** on the
`staging` ref.

```
states: IDLE → BUILDING → VALIDATING → ACTIVATING → VERIFYING → PROMOTED
                      └────────────── any failure ──────────────┐
                                                                 ▼
                                                            ROLLING_BACK
                                                                 │
                                              (feed logs to AI, attempt++)
                                                                 ▼
                                                  REPAIRING ──► BUILDING (loop)
                                                                 │
                                          budget (8h) exceeded ──► PARKED
```

Step detail:

1. **BUILDING** — check out the candidate commit into an **isolated git
   worktree**; run `build` for affected workspaces. Build into a side location
   so the running version is never half-overwritten.
2. **VALIDATING** — `typecheck` + unit `test` (+ smoke/e2e where available,
   e.g. `apps/web` has `test:e2e`). Failure → ROLLING_BACK.
3. **ACTIVATING** — graceful restart of affected service(s) pointing at the new
   artifact (uses the now-fast shutdown + session auto-restore so the AI's own
   chat survives the restart).
4. **VERIFYING** — readiness probe held for a **stability window** (e.g. 30–60s)
   - a **smoke check** (hit a key endpoint / render the page). Failure → ROLLING_BACK.
5. **PROMOTED** — set `known-good = candidate` (fast-forward `live` → `staging`).
   Stable; loop ends successfully.
6. **ROLLING_BACK** — restart the known-good artifact (live is healthy again),
   capture `{failed step, diff, build/test/health logs}`, hand to the AI.
7. **REPAIRING** — AI edits → new commit on `staging` → back to BUILDING.
8. **PARKED** — see §8.

**Live safety invariant:** at every moment outside the brief ACTIVATING/
VERIFYING window, the _serving_ version is a known-good one. A failed candidate
never stays live.

## 6. Service contract (what every service must expose)

Extends `ServiceSpec` (`apps/server/src/services/service-supervisor.ts`). New
services satisfy this and get the whole loop for free.

```ts
interface DeployableServiceSpec extends ServiceSpec {
  /** Workspaces/paths this service builds from (for change → service mapping). */
  sources: string[];
  /** Build the candidate (already partly exists as watch.rebuild). */
  build: () => Promise<void>;
  /** Validate the candidate before activation. Non-zero/throw = fail. */
  validate: () => Promise<{ ok: boolean; logs: string }>; // typecheck + tests
  /** Readiness: is it ready to serve right now? (beyond "process alive") */
  readiness: () => Promise<boolean>;
  /** Liveness: is it healthy over time? (catches alive-but-wedged) */
  liveness?: () => Promise<boolean>;
  /** Smoke test after activation (hit endpoint / render). */
  smoke?: () => Promise<{ ok: boolean; logs: string }>;
  /** Services that must be healthy first; rollback/activate in this order. */
  dependsOn?: string[];
}
```

- `readiness`/`liveness` are the **rollback signal**. The loop is only as good
  as these probes — invest here.
- Multi-service changes activate / verify / roll back **as one unit in
  dependency order** (`dependsOn`).

## 7. Versioning & rollback backbone: git

- `live` ref = **known-good** (what production serves).
- `staging` ref = candidate (where the AI commits its attempts).
- **Promote** = fast-forward `live` → `staging`.
- **Roll back** = reset `staging` → `live` (live is never moved on failure).
- **Isolated build/validate** = `git worktree` for the candidate, so the running
  tree is untouched until promotion.
- Every AI attempt is a commit → full **audit trail + diffs** for free.

Identity/permissions: the deployer must run as the **repo owner** (or configure
`safe.directory` + correct ACLs). Note the live finding: commands here run as
`NT AUTHORITY/SYSTEM` while the repo is owned by `Administrator`, which breaks
git. The deployer install must resolve this (run-as user or ACL fix).

## 8. Repair-loop budget & PARK semantics

- **Budget: 8 hours wall-clock** measured from when the loop starts working a
  given change-set (not summed work-time, not attempt count).
- While under budget: failures loop (BUILDING → … → REPAIRING → BUILDING) with
  sensible backoff between attempts.
- **On budget exhaustion → PARKED:**
  1. **Ping the human** (chat system item + Services screen banner + log).
  2. **Live system is left on the last known-good** version (stable).
  3. **Preserve everything** — do **not** discard:
     - the `staging` branch with **all** AI attempts/commits,
     - the per-attempt **logs** (build/test/health/diff),
     - an **attempt journal** (what was tried, why each failed),
     - the candidate worktree (or enough to recreate it).
  4. Record state = `parked: awaiting human decision` with a one-click
     **Resume** (continue the loop) or **Discard** (human-initiated only).

The human decides whether to continue; the system never throws the effort away
on its own.

## 9. Safety rails (non-negotiable)

- **Off-limits paths** (refuse to auto-deploy if the diff touches these):
  the **deployer** source, **auth** (`~/.pi` / auth files), **install/service
  scripts** (`scripts/service/*`), **CI** config. Such changes require a human
  gate.
- **State/migrations:** code rollback does **not** roll back data. Flag any diff
  that changes on-disk/DB/session formats for human review (today state is just
  Pi session files — low risk, but the rule stands).
- **Atomicity:** one deploy in flight at a time; queue further commits.
- **Validation isolation:** build/test the candidate in a worktree so a broken
  candidate can't corrupt the live tree.
- **Resource limits:** per-attempt time/token budget in addition to the 8h
  wall-clock cap; never let a build/test hang forever.
- **Deployer immutability:** the AI loop cannot modify the deployer or the
  off-limits set without a human.

## 10. Observability (Services screen)

Reuse the existing inventory (`ServiceRegistry` + Services tab). Add per
change-set:

- current **phase** (BUILDING/VALIDATING/…/PROMOTED/ROLLING_BACK/PARKED),
- **attempt N**, elapsed vs. 8h budget,
- last failure **step + logs**, current diff,
- controls: **Pause**, **Resume**, **Discard** (human), **View attempt journal**.

## 11. What already exists vs. to build

**Exists:** `ServiceSupervisor` watch→rebuild→restart; `/health`; fast graceful
restart (closes sockets, ~<1s); session **auto-restore on reconnect**; per-
workspace `build`/`test`/`typecheck` (+ web `test:e2e`); git repo; PI SDK agent
in-process; Services screen with start/stop/restart.

**To build:**

1. Probes + validation gate on `ServiceSpec` (§6).
2. Git known-good model + isolated worktree build + atomic promote/rollback (§7).
3. **Separate deployer process** under NSSM/runtime (§4) with the off-limits
   guard (§9).
4. AI repair feedback loop (failure context → PI SDK → retry) (§5).
5. Budget + PARK semantics (§8) and Services-screen phase UI (§10).

## 12. Phased plan (each phase independently shippable)

- **Phase 1 — Contract & gate (web only). ✅ DONE.** Added `validate`/`readiness`
  /`liveness`/`smoke`/`dependsOn`/`sources` to `ServiceSpec`; the supervisor now
  runs a **validation gate** (`validating` state) before rebuild/restart and a
  post-activation readiness probe (log-only). The web service validates via
  `tsc --noEmit` before each hot-reload activation and probes the web port for
  readiness. A failed validate keeps the current version untouched and records
  the logs. Covered by unit tests in `service-supervisor.test.ts`.
  _Value: broken web changes are caught before going live._
  _Note: trigger is currently hot-reload file-watch; commit-triggering moves in
  with the deployer (Phase 2)._
- **Phase 2 — Auto rollback.** Git known-good + worktree build + promote/rollback,
  driven by the **separate deployer process**. _Value: bad web change auto-reverts._
  - **Engine: ✅ DONE (not yet wired).** `apps/server/src/services/deploy-controller.ts`
    implements the pure, injected-dependency control loop
    (build→validate→activate→verify, rollback-on-failure, AI repair retry, 8h
    wall-clock budget, PARK-preserving-journal). Fully unit-tested in
    `deploy-controller.test.ts` (promote / repair-then-promote / live-safety /
    budget park / AI-gives-up park / maxAttempts).
  - **`KnownGoodStore` (git): ✅ DONE.** `git-known-good.ts` implements
    `mark`/`promote`/`rollback` over `live`/`staging` refs, unit-tested with
    real git against a throwaway temp repo (`git-known-good.test.ts`). Identity
    resolved — the service now runs as **Administrator** (repo owner).
  - **`DeployPipeline` adapter: ✅ DONE.** `service-deploy-pipeline.ts`
    (build/validate/**activate=restart**/verify with a stability window +
    smoke), unit-tested (`service-deploy-pipeline.test.ts`).
  - **Commit trigger: ✅ DONE.** `commit-trigger.ts` watches the `staging` ref
    and fires on new commits (baseline-skip), unit-tested.
  - **Deployer entrypoint: ✅ CODE-COMPLETE (web-only, needs live debug).**
    `start-deployer.ts` is the separate process assembling all the tested
    modules: watches `staging`, builds (typecheck + `next build`), activates by
    POSTing the API's `/api/services/web/restart`, verifies readiness + smoke,
    and rolls back via git reset + rebuild + restart. PARK writes the journal to
    `logs/deploy-journal.json`. Scripts: `npm run dev:deployer` /
    `start:deployer` (workspace `@mca/server`).
  - **Repair agent (3b): STUB.** Decision: route repair **through the existing
    chat** (visible/interruptible), not a hidden headless session.
    `RepairAgent` in the deployer currently parks; the chat-routed impl is the
    next code drop. _Reconciliation:_ the AI's repair turn completes + commits
    while the API is up; activation restarts web; the chat auto-restores on
    reconnect (already built), so the visible chat survives the restart.
  - **Remaining to go live (debug together):**
    1. one-time git setup: create `live` + `staging` branches
       (`git branch live && git branch staging`);
    2. register the deployer as a **second NSSM service** (own process, runs as
       Administrator); 3. iterate the build/activate/verify timings against the
       running web service; 4. wire the chat-routed `RepairAgent`.
  - **Refinement deferred:** build in an isolated `git worktree` (currently
    builds in-place on `staging`; rollback rebuilds known-good, so it's
    recoverable, just not isolated).
- **Phase 3 — AI repair loop + budget.** Feed failure context to the agent;
  retry; 8h wall-clock budget; PARK + ping. _Value: closes the self-healing loop._
- **Phase 4 — Expand scope.** Bring `api` + `packages/shared` under the contract
  with `dependsOn` ordering and coordinated multi-service deploys.

## 13. Multi-session considerations (up to ~20 concurrent chat sessions)

The deploy loop is **unaffected**: a deploy is a system-wide singleton (one in
flight, others queued) no matter how many chats exist. But many sessions change
**continuity across the restarts a deploy causes**:

- A deploy restart drops **all** live WebSocket connections at once. Fast
  shutdown (done) + socket.io `connectionStateRecovery` + per-session restore
  are what make this a brief, transparent blip rather than 20 broken chats.
- The current reconnect restore uses `continueRecent` (reopen the single
  most-recent session). Correct for one active chat, **wrong for many** — every
  client would get the same session. Correct multi-session support needs:
  - distinct, **persisted `sessionId` per conversation** (client-side), and
  - the server **resuming that specific session file** on reconnect.
    Server-side isolation already exists (room-per-session in `handlers.ts`); the
    gaps are client-side per-conversation ids + restore-by-file.
- Resource footprint: up to ~20 in-memory `AgentSession`s + 20 socket rooms.
  Acceptable, but worth a cap/idle-eviction policy later.

_This is a separate workstream from the deploy loop and is tracked here so the
deploy restarts don't regress multi-session continuity._

## 14. Open questions

- Exact **readiness/smoke** definition per service (what "works" means in code).
- Stability-window length and backoff between repair attempts.
- PARK/Resume UX: chat affordance vs. Services-screen control (likely both).
