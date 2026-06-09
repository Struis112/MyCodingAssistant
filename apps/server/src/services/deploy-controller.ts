// Self-Healing Deploy Controller (Phase 2 core)
//
// The decision engine behind the AI-authored deploy loop described in
// docs/architecture/self-healing-deploy.md:
//
//   build -> validate -> activate -> verify
//        └────────── any failure ──────────┐
//                                           ▼
//                                  roll back to known-good,
//                                  hand logs to the AI to repair,
//                                  retry — until stable, or the
//                                  8h wall-clock budget is spent.
//
// This module is intentionally PURE and side-effect-free: every environment
// touch (git ref switching, building, restarting, probing, invoking the AI)
// is injected via the interfaces below. That keeps the loop deterministic and
// unit-testable, and decouples it from the not-yet-decided bits (git identity,
// in-process vs. separate deployer process). The real adapters are wired in a
// later step once those decisions are made.
//
// Safety invariants this engine guarantees:
//   * The LIVE system is rolled back to a known-good version on EVERY failed
//     candidate (never left on a broken one).
//   * On budget exhaustion (or the AI giving up) it PARKS: live stays on
//     known-good, and the full attempt journal is returned so the caller can
//     preserve the in-progress effort for the human to resume. Nothing is
//     thrown away by the engine.

/** 8 hours of WALL-CLOCK time per change-set (not summed work-time). */
export const DEFAULT_DEPLOY_BUDGET_MS = 8 * 60 * 60 * 1000;

export type DeployPhase =
  | "idle"
  | "building"
  | "validating"
  | "activating"
  | "verifying"
  | "promoted"
  | "rolling_back"
  | "repairing"
  | "parked";

export interface StepResult {
  ok: boolean;
  /** Combined build/test/probe output — fed to the AI on failure. */
  logs?: string;
}

/** The four gated steps for one candidate. Each must be safe to retry. */
export interface DeployPipeline {
  /** Compile/build the candidate (ideally in an isolated worktree). */
  build(): Promise<StepResult>;
  /** Typecheck + tests (+ smoke) BEFORE activation. */
  validate(): Promise<StepResult>;
  /** Activate the candidate (graceful restart pointing at the new artifact). */
  activate(): Promise<StepResult>;
  /** Readiness held for a stability window (+ smoke) AFTER activation. */
  verify(): Promise<StepResult>;
}

/** Known-good version store. Real impl is git-backed (live/staging refs). */
export interface KnownGoodStore {
  /** Snapshot the current live version as the known-good baseline. */
  mark(): Promise<void>;
  /** Promote the validated candidate to known-good. */
  promote(): Promise<void>;
  /** Restore the live system to the last known-good version. */
  rollback(): Promise<void>;
}

export interface RepairContext {
  attempt: number;
  failedPhase: DeployPhase;
  logs: string;
  elapsedMs: number;
  remainingMs: number;
}

/** Hands failure context to the AI to produce the next candidate. */
export interface RepairAgent {
  /**
   * Resolve `true` when a NEW candidate is ready to try, or `false` when the
   * AI produced no change (give up → park). Implementations should respect
   * `ctx.remainingMs` as their own time budget.
   */
  attempt(ctx: RepairContext): Promise<boolean>;
}

export type AttemptOutcome = "promoted" | "rolled_back" | "parked";

export interface AttemptRecord {
  attempt: number;
  outcome: AttemptOutcome;
  failedPhase?: DeployPhase;
  logs?: string;
  at: number;
}

export interface DeployControllerOptions {
  pipeline: DeployPipeline;
  knownGood: KnownGoodStore;
  repair: RepairAgent;
  /** Wall-clock budget for the whole loop. Default 8h. */
  budgetMs?: number;
  /** Optional secondary hard cap on attempts (wall-clock is primary). */
  maxAttempts?: number;
  /** Injectable clock (ms epoch) for testability. */
  now?: () => number;
  /** Phase change callback (UI/logs). */
  onPhase?: (phase: DeployPhase, info?: { attempt: number; elapsedMs: number }) => void;
}

export interface DeployResult {
  outcome: "promoted" | "parked";
  attempts: number;
  journal: AttemptRecord[];
  elapsedMs: number;
  /** Set when parked, so the UI can explain why. */
  parkedReason?: "budget_exhausted" | "max_attempts" | "ai_gave_up";
}

export class DeployController {
  private pipeline: DeployPipeline;
  private knownGood: KnownGoodStore;
  private repair: RepairAgent;
  private budgetMs: number;
  private maxAttempts: number;
  private now: () => number;
  private onPhase?: DeployControllerOptions["onPhase"];

  private phase: DeployPhase = "idle";

  constructor(opts: DeployControllerOptions) {
    this.pipeline = opts.pipeline;
    this.knownGood = opts.knownGood;
    this.repair = opts.repair;
    this.budgetMs = opts.budgetMs ?? DEFAULT_DEPLOY_BUDGET_MS;
    this.maxAttempts = opts.maxAttempts ?? Infinity;
    this.now = opts.now ?? Date.now;
    this.onPhase = opts.onPhase;
  }

  getPhase(): DeployPhase {
    return this.phase;
  }

  /**
   * Drive one change-set to a stable state. Returns `promoted` when a candidate
   * passes all gates, or `parked` (live on known-good, journal preserved) when
   * the budget/attempts run out or the AI gives up.
   */
  async run(): Promise<DeployResult> {
    const start = this.now();
    const journal: AttemptRecord[] = [];
    await this.knownGood.mark();

    let attempt = 1;
    const elapsed = () => this.now() - start;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Budget / attempt gate, checked before doing work so a long repair
      // can't push us past the cap unnoticed.
      if (elapsed() > this.budgetMs || attempt > this.maxAttempts) {
        const reason = attempt > this.maxAttempts ? "max_attempts" : "budget_exhausted";
        return this.park(journal, attempt, start, reason);
      }

      const steps: Array<[DeployPhase, () => Promise<StepResult>]> = [
        ["building", () => this.pipeline.build()],
        ["validating", () => this.pipeline.validate()],
        ["activating", () => this.pipeline.activate()],
        ["verifying", () => this.pipeline.verify()],
      ];

      let failure: { phase: DeployPhase; logs: string } | null = null;
      for (const [phase, fn] of steps) {
        this.setPhase(phase, attempt, start);
        // eslint-disable-next-line no-await-in-loop
        const result = await fn();
        if (!result.ok) {
          failure = { phase, logs: result.logs ?? "" };
          break;
        }
      }

      if (!failure) {
        this.setPhase("promoted", attempt, start);
        // eslint-disable-next-line no-await-in-loop
        await this.knownGood.promote();
        journal.push({ attempt, outcome: "promoted", at: this.now() });
        return { outcome: "promoted", attempts: attempt, journal, elapsedMs: elapsed() };
      }

      // Candidate failed: get the LIVE system back on known-good immediately,
      // record the attempt, then ask the AI to produce the next candidate.
      this.setPhase("rolling_back", attempt, start);
      // eslint-disable-next-line no-await-in-loop
      await this.knownGood.rollback();
      journal.push({
        attempt,
        outcome: "rolled_back",
        failedPhase: failure.phase,
        logs: failure.logs,
        at: this.now(),
      });

      this.setPhase("repairing", attempt, start);
      const remainingMs = Math.max(0, this.budgetMs - elapsed());
      // eslint-disable-next-line no-await-in-loop
      const hasNewCandidate = await this.repair.attempt({
        attempt,
        failedPhase: failure.phase,
        logs: failure.logs,
        elapsedMs: elapsed(),
        remainingMs,
      });

      if (!hasNewCandidate) {
        return this.park(journal, attempt, start, "ai_gave_up");
      }
      attempt += 1;
    }
  }

  // ----- internals -----

  /** Park: ensure live is on known-good, record it, preserve the journal. */
  private async park(
    journal: AttemptRecord[],
    attempt: number,
    start: number,
    reason: DeployResult["parkedReason"],
  ): Promise<DeployResult> {
    // Defensive: guarantee the live system is on a known-good version. Rollback
    // is expected to be idempotent.
    await this.knownGood.rollback();
    this.setPhase("parked", attempt, start);
    journal.push({ attempt, outcome: "parked", at: this.now() });
    return {
      outcome: "parked",
      attempts: attempt,
      journal,
      elapsedMs: this.now() - start,
      parkedReason: reason,
    };
  }

  private setPhase(phase: DeployPhase, attempt: number, start: number): void {
    this.phase = phase;
    this.onPhase?.(phase, { attempt, elapsedMs: this.now() - start });
  }
}
