// Self-healing-deploy repair session (Phase 3 — chat-routed AI repair).
//
// Owns ONE persistent chat session ("Self-healing deploy"). When a deploy
// attempt fails, the deployer process POSTs the failure context here; we:
//
//   1. Resolve (or create) the dedicated session and lock its model.
//   2. Snapshot the current `staging` SHA so we can detect the AI's commit.
//   3. Send a structured user message describing the failure.
//   4. Poll `staging` HEAD until the SHA changes (= AI committed a fix) OR the
//      agent stops streaming without committing (= give up) OR we run out of
//      `remainingMs` (= timeout — give up).
//   5. Return the new SHA (or null = give up); the deployer's controller turns
//      that into "retry from BUILDING" or "PARK".
//
// The session is **visible** in the UI exactly like any other chat: the user
// can watch the AI work, interrupt with their own messages, or take over —
// because conversation messages are saved to disk by the harness, not us.
// But the system runs autonomously too: nothing here waits for human input,
// and PARK (in start-deployer) preserves the journal so a human can resume
// when convenient.
//
// All side-effects (clock, git, chat) are injected, so the polling logic is
// deterministic under test.

import { spawn } from "node:child_process";
import path from "node:path";
import type { ConnectorManager, AgentLike } from "../connectors/types.js";

export interface RepairFailureContext {
  attempt: number;
  /** Which step of the pipeline failed (build/validate/activate/verify). */
  failedPhase: string;
  /** Combined build/test/probe output — usually capped by the deployer. */
  logs: string;
  /** Wall-clock spent on the change-set so far. */
  elapsedMs: number;
  /** Wall-clock the AI has left before the controller parks. */
  remainingMs: number;
}

export interface RepairParkContext {
  reason: string;
  attempts: number;
  /** Optional summary the deployer wants surfaced to the human. */
  summary?: string;
  /** Current known-good SHA (what `live` is back on). */
  liveSha?: string;
}

export interface RepairResolution {
  /** New `staging` SHA if the AI committed a candidate, else null. */
  newSha: string | null;
  /** Why we returned — useful in journal entries. */
  reason: "committed" | "gave_up" | "timed_out";
}

export interface RepairSessionOptions {
  manager: ConnectorManager;
  /** Repo root — git ops are run with `-C <repoDir>`. */
  repoDir: string;
  /** Ref the AI is expected to commit to. Default "staging". */
  stagingRef?: string;
  /** Dedicated session id (stable across attempts). Default "__deploy_repair__". */
  sessionId?: string;
  /** Persisted session file path. Default `<repoDir>/logs/repair-sessions/self-healing.jsonl`. */
  sessionFile?: string;
  /** Model id (e.g. "anthropic/claude-sonnet-4-5"). */
  model?: string;
  /** Session display name. Default "Self-healing deploy". */
  sessionName?: string;
  /** How often to poll git for the new SHA. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Emit a socket event to all clients on park. Optional; null = no-op. */
  onPark?: (ctx: RepairParkContext) => void;
  /** Injectable git rev-parse (tests). */
  revParse?: (ref: string) => Promise<string | null>;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests). */
  now?: () => number;
}

const DEFAULT_SESSION_ID = "__deploy_repair__";
const DEFAULT_SESSION_NAME = "Self-healing deploy";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const DEFAULT_POLL_MS = 2_000;

/** Default `git -C <repoDir> rev-parse <ref>`. Returns null on missing ref. */
function makeDefaultRevParse(repoDir: string): (ref: string) => Promise<string | null> {
  return (ref) =>
    new Promise((resolve) => {
      let out = "";
      const proc = spawn("git", ["-C", repoDir, "rev-parse", ref], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => resolve(code === 0 ? out.trim() || null : null));
      proc.on("error", () => resolve(null));
    });
}

export class RepairSessionService {
  private manager: ConnectorManager;
  private repoDir: string;
  private stagingRef: string;
  private sessionId: string;
  private sessionFile: string;
  private modelId: string;
  private sessionName: string;
  private pollIntervalMs: number;
  private onParkCb: ((ctx: RepairParkContext) => void) | undefined;
  private revParse: (ref: string) => Promise<string | null>;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  /** Cached: have we already named + set the model on this session? */
  private sessionPrimed = false;

  constructor(opts: RepairSessionOptions) {
    this.manager = opts.manager;
    this.repoDir = opts.repoDir;
    this.stagingRef = opts.stagingRef ?? "staging";
    this.sessionId = opts.sessionId ?? DEFAULT_SESSION_ID;
    this.sessionFile =
      opts.sessionFile ?? path.join(opts.repoDir, "logs", "repair-sessions", "self-healing.jsonl");
    this.modelId = opts.model ?? DEFAULT_MODEL;
    this.sessionName = opts.sessionName ?? DEFAULT_SESSION_NAME;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.onParkCb = opts.onPark;
    this.revParse = opts.revParse ?? makeDefaultRevParse(opts.repoDir);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /**
   * Send the failure context to the AI and wait for a fix-commit (or give up).
   * Returns the new `staging` SHA or null with a reason code.
   */
  async requestRepair(ctx: RepairFailureContext): Promise<RepairResolution> {
    const agent = await this.ensureSession();
    const beforeSha = (await this.revParse(this.stagingRef)) ?? "";

    // Build a single, structured message. The AI's harness already has the
    // system prompt + repo context; we just hand it the failure-specific bits.
    const message = this.formatFailureMessage(ctx, beforeSha);

    // If a previous repair turn is still streaming (shouldn't happen — the
    // deployer is single-flight), follow up instead of throwing.
    if (agent.isStreaming) {
      await agent.followUp(message);
    } else {
      // Fire-and-forget the prompt: the harness streams in the background.
      // We resolve based on git/agent state, not on prompt() returning.
      void agent.prompt(message).catch((err) => {
        // Surfacing here is best-effort — the AI may yet recover; we don't
        // cancel the wait loop on a transient harness error.
        // eslint-disable-next-line no-console
        console.warn(`[repair] prompt failed: ${String(err)}`);
      });
    }

    return this.waitForResolution(agent, beforeSha, ctx.remainingMs);
  }

  /** Notify the chat (and any listeners) that the controller has parked. */
  recordPark(ctx: RepairParkContext): void {
    if (this.onParkCb) {
      try {
        this.onParkCb(ctx);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[repair] onPark callback threw: ${String(err)}`);
      }
    }
    // Post a system-style message into the session so a human reading it later
    // sees the outcome inline. Best effort — never throws.
    void this.ensureSession()
      .then((agent) => {
        const summary =
          ctx.summary?.trim() ||
          `Deploy parked after ${ctx.attempts} attempt(s) (reason: ${ctx.reason}). ` +
            (ctx.liveSha
              ? `Live is back on \`${ctx.liveSha.slice(0, 8)}\` (known-good).`
              : "Live is back on known-good.");
        return agent.followUp(`[deploy-system] ${summary}`);
      })
      .catch(() => {
        /* best effort */
      });
  }

  // ----- internals -----

  private async ensureSession(): Promise<AgentLike> {
    const existing = this.manager.getSession(this.sessionId);
    if (existing) return existing;
    const agent = await this.manager.getOrCreateSession(this.sessionId, {
      sessionFile: this.sessionFile,
    });
    if (!this.sessionPrimed) {
      try {
        // The model id is `provider/modelId` in the registry; the manager
        // takes them split.
        const slashAt = this.modelId.indexOf("/");
        if (slashAt > 0) {
          const provider = this.modelId.slice(0, slashAt);
          const modelOnly = this.modelId.slice(slashAt + 1);
          await this.manager.setSessionModel(this.sessionId, provider, modelOnly);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[repair] could not set model '${this.modelId}' on session: ${String(err)}. ` +
            `Continuing with whatever default the harness picked.`,
        );
      }
      try {
        this.manager.setSessionName(this.sessionId, this.sessionName);
      } catch {
        /* harmless */
      }
      this.sessionPrimed = true;
    }
    return agent;
  }

  /**
   * Poll the staging ref until it advances past `beforeSha`, or the agent
   * settles without committing, or we run out of time.
   */
  private async waitForResolution(
    agent: AgentLike,
    beforeSha: string,
    remainingMs: number,
  ): Promise<RepairResolution> {
    const deadline = this.now() + Math.max(0, remainingMs);
    // Brief grace period so we don't declare "gave_up" the instant we look,
    // before the harness even has a chance to start streaming.
    const STREAM_GRACE_MS = 5_000;
    const start = this.now();

    while (this.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await this.sleep(this.pollIntervalMs);
      // eslint-disable-next-line no-await-in-loop
      const now = await this.revParse(this.stagingRef);
      if (now && now !== beforeSha) {
        return { newSha: now, reason: "committed" };
      }
      // If the agent finished its turn (idle) AND we're past the grace
      // window, treat it as "gave up" — no commit will be coming.
      if (!agent.isStreaming && this.now() - start > STREAM_GRACE_MS) {
        return { newSha: null, reason: "gave_up" };
      }
    }
    return { newSha: null, reason: "timed_out" };
  }

  /**
   * The single, focused message we send the AI. Format chosen for the AI's
   * benefit (clear section headers, explicit "what to do") and for grep-ability
   * in the chat history. We deliberately do NOT include the full diff — the AI
   * has tools to git-diff itself, and pasting noise just costs tokens.
   */
  private formatFailureMessage(ctx: RepairFailureContext, beforeSha: string): string {
    const minutesLeft = Math.max(0, Math.round(ctx.remainingMs / 60_000));
    // Cap logs aggressively — anthropic context isn't infinite and the tail
    // is almost always the actionable part. The deployer caps too; this is
    // a backstop.
    const MAX_LOG_BYTES = 12 * 1024;
    const logs =
      ctx.logs.length > MAX_LOG_BYTES
        ? `[…truncated…]\n${ctx.logs.slice(-MAX_LOG_BYTES)}`
        : ctx.logs;

    return [
      "[deploy-system] A deploy attempt just failed and was rolled back.",
      "",
      `Attempt: ${ctx.attempt}`,
      `Failed phase: ${ctx.failedPhase}`,
      `Elapsed on this change-set: ${Math.round(ctx.elapsedMs / 1000)}s`,
      `Time budget left: ~${minutesLeft} minute(s)`,
      `Candidate ref: ${this.stagingRef} @ ${beforeSha.slice(0, 8) || "?"}`,
      "",
      "Failure logs (tail):",
      "```",
      logs,
      "```",
      "",
      "Please:",
      `  1. Diagnose the failure from the logs above.`,
      `  2. Make the minimal fix needed (do NOT broaden scope).`,
      `  3. Commit the fix to \`${this.stagingRef}\`. The deployer detects the new`,
      `     commit and re-runs the gated pipeline automatically.`,
      "",
      "If you can't fix it in this attempt, say so explicitly and STOP — the",
      "controller will park to known-good and wait for a human. Don't ship",
      "speculative changes that broaden scope just to look productive.",
    ].join("\n");
  }
}
