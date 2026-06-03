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
  private onCommit: (sha: string) => void;

  private last: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(opts: CommitTriggerOptions) {
    this.ref = opts.ref ?? "staging";
    this.intervalMs = opts.intervalMs ?? 2_000;
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
      if (!sha || sha === this.last) return false;
      const isBaseline = this.last === null;
      this.last = sha;
      if (isBaseline) return false;
      this.onCommit(sha);
      return true;
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
