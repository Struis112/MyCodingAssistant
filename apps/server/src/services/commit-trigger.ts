// Commit trigger (Phase 2)
//
// The deploy loop is COMMIT-triggered, not file-watch triggered: a commit is
// the AI's atomic "this change is done, deploy it" signal, whereas raw file
// events fire on half-written edits. This watches a git ref (default the
// `staging` candidate branch) and fires `onCommit` whenever its tip advances.
//
// The first observation only establishes a baseline (the currently-deployed
// commit) and does NOT fire — we don't redeploy what's already live on startup.
//
// The git read is injected (`poll`) so the logic is unit-testable; the default
// reads `git rev-parse <ref>`.

import { spawn } from "node:child_process";

export interface CommitTriggerOptions {
  /** Branch/ref to watch. Default "staging". */
  ref?: string;
  /** Repo directory (for the default poller). */
  repoDir?: string;
  /** Returns the current commit sha of the ref, or null if unresolved. */
  poll?: () => Promise<string | null>;
  /** Poll cadence. Default 2s. */
  intervalMs?: number;
  /**
   * Quiet-period coalescing: when > 0, a new commit does NOT fire
   * immediately — the trigger waits until the ref has been stable for
   * `quietMs`, then fires ONCE with the latest sha. Bursts of commits (the
   * repair agent's verification pings) become a single deploy instead of a
   * restart per commit. Default 0 = fire immediately (old behavior).
   */
  quietMs?: number;
  /** Upper bound on coalescing: fire at most this long after the FIRST queued
   * commit even if commits keep arriving. Default 10 min. */
  maxWaitMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Fired when the ref advances to a new commit (after the baseline). */
  onCommit: (sha: string) => void;
}

function makeDefaultPoller(repoDir: string, ref: string): () => Promise<string | null> {
  return () =>
    new Promise<string | null>((resolve) => {
      const proc = spawn("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", ref], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => resolve(code === 0 ? out.trim() || null : null));
      proc.on("error", () => resolve(null));
    });
}

export class CommitTrigger {
  private ref: string;
  private poll: () => Promise<string | null>;
  private intervalMs: number;
  private quietMs: number;
  private maxWaitMs: number;
  private now: () => number;
  private onCommit: (sha: string) => void;

  private last: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  // Coalescing state: a sha waiting out its quiet period.
  private pendingSha: string | null = null;
  private pendingFirstAt = 0;
  private pendingLastChangeAt = 0;

  constructor(opts: CommitTriggerOptions) {
    this.ref = opts.ref ?? "staging";
    this.intervalMs = opts.intervalMs ?? 2_000;
    this.quietMs = opts.quietMs ?? 0;
    this.maxWaitMs = opts.maxWaitMs ?? 600_000;
    this.now = opts.now ?? Date.now;
    this.onCommit = opts.onCommit;
    this.poll = opts.poll ?? makeDefaultPoller(opts.repoDir ?? process.cwd(), this.ref);
  }

  /**
   * One poll cycle. Returns true if a new commit fired `onCommit`. The first
   * resolved sha is recorded as the baseline and does NOT fire.
   */
  async checkOnce(): Promise<boolean> {
    if (this.checking) return false;
    this.checking = true;
    try {
      const sha = await this.poll();
      const nowMs = this.now();

      if (sha && sha !== this.last) {
        const isBaseline = this.last === null;
        this.last = sha;
        if (!isBaseline) {
          if (this.quietMs <= 0) {
            this.onCommit(sha);
            return true;
          }
          // Queue / extend the quiet period with the newest sha.
          if (!this.pendingSha) this.pendingFirstAt = nowMs;
          this.pendingSha = sha;
          this.pendingLastChangeAt = nowMs;
        }
      }

      // Fire a queued sha once the ref has been quiet long enough (or the
      // max-wait cap is hit, so a steady commit stream can't starve deploys).
      if (
        this.pendingSha &&
        (nowMs - this.pendingLastChangeAt >= this.quietMs ||
          nowMs - this.pendingFirstAt >= this.maxWaitMs)
      ) {
        const fire = this.pendingSha;
        this.pendingSha = null;
        this.onCommit(fire);
        return true;
      }
      return false;
    } finally {
      this.checking = false;
    }
  }

  /** Begin polling. Establishes the baseline on the first cycle. */
  start(): void {
    if (this.timer) return;
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The last observed commit sha (baseline or fired). */
  get lastSeen(): string | null {
    return this.last;
  }
}
