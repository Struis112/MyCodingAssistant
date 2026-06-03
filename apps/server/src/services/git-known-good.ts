// Git-backed KnownGoodStore (Phase 2 adapter)
//
// Implements the DeployController's KnownGoodStore over two git refs, per
// docs/architecture/self-healing-deploy.md:
//
//   live    = last KNOWN-GOOD commit (what production should serve)
//   staging = candidate branch (where the AI commits its attempts)
//
//   mark()     -> ensure `live` exists (baseline = current staging tip)
//   promote()  -> move `live` to the validated candidate  (branch -f live staging)
//   rollback() -> return the working tree to known-good    (reset --hard live)
//
// The git runner is injected so the logic is unit-testable; the default runner
// shells out to `git -C <repoDir>`. The deployer process runs as the repo owner
// (Administrator), so git operations have the right identity.

import { spawn } from "node:child_process";
import type { KnownGoodStore } from "./deploy-controller.js";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[]) => Promise<GitRunResult>;

export interface GitKnownGoodOptions {
  repoDir: string;
  /** Known-good ref name. Default "live". */
  liveRef?: string;
  /** Candidate branch name. Default "staging". */
  stagingRef?: string;
  /** Injectable git runner (tests). Default shells out to git. */
  run?: GitRunner;
}

/** Default runner: `git -C <repoDir> <args...>`. */
function makeDefaultRunner(repoDir: string): GitRunner {
  return (args: string[]) =>
    new Promise<GitRunResult>((resolve) => {
      const proc = spawn("git", ["-C", repoDir, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
    });
}

export class GitKnownGoodStore implements KnownGoodStore {
  private repoDir: string;
  private live: string;
  private staging: string;
  private run: GitRunner;

  constructor(opts: GitKnownGoodOptions) {
    this.repoDir = opts.repoDir;
    this.live = opts.liveRef ?? "live";
    this.staging = opts.stagingRef ?? "staging";
    this.run = opts.run ?? makeDefaultRunner(this.repoDir);
  }

  /** True when a ref/commit resolves. */
  private async refExists(ref: string): Promise<boolean> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", ref]);
    return r.code === 0;
  }

  private async git(args: string[], context: string): Promise<void> {
    const r = await this.run(args);
    if (r.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (${context}): ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
  }

  /**
   * Ensure the known-good baseline exists. If `live` is absent (first deploy),
   * create it at the current `staging` tip — i.e. treat whatever is currently
   * deployed as the baseline we can roll back to.
   */
  async mark(): Promise<void> {
    if (await this.refExists(this.live)) return;
    if (!(await this.refExists(this.staging))) {
      throw new Error(
        `GitKnownGoodStore.mark: neither '${this.live}' nor '${this.staging}' exist in ${this.repoDir}`,
      );
    }
    await this.git(["branch", "-f", this.live, this.staging], "create live baseline");
  }

  /** Promote the validated candidate: live -> staging tip. */
  async promote(): Promise<void> {
    await this.git(["branch", "-f", this.live, this.staging], "promote");
  }

  /**
   * Roll the working tree back to the last known-good. Ensures we're on the
   * staging branch and hard-resets it to `live`, so a subsequent rebuild/restart
   * serves the known-good code.
   */
  async rollback(): Promise<void> {
    await this.git(["checkout", "-f", this.staging], "rollback: checkout staging");
    await this.git(["reset", "--hard", this.live], "rollback: reset to live");
  }
}
