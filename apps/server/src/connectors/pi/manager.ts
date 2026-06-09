// Pi SDK connector — session manager.
// Wraps @earendil-works/pi-coding-agent for persistent, multi-session use.
// Sessions live on disk in ~/.pi/agent/sessions/ so the assistant resumes
// across server restarts.
//
// This file moved from `apps/server/src/services/pi-session.ts` as part of
// the multi-connector refactor (Phase A). Behaviour is unchanged.

import { unlink } from "node:fs/promises";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  AccountUsage,
  ProviderInfo,
  ActiveSessionInfo,
  AgentLike,
  AgentModel,
  AvailableModel,
  ConnectorManager,
  PersistedSessionDescriptor,
  ThinkingLevel,
} from "../types.js";

// ---- Account usage (Anthropic 5-hour + weekly limits) ----
// These limits aren't exposed by the SDK, so we query Anthropic directly with
// the stored OAuth token. The exact endpoint/shape is undocumented, so parsing
// is defensive and the route can return a debug passthrough to finalize it.

function clampPct(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickNum(o: any, keys: string[]): number | undefined {
  for (const k of keys) if (o && typeof o[k] === "number") return o[k];
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function windowPct(w: any): number | null {
  if (!w || typeof w !== "object") return null;
  // Anthropic reports `utilization` as a percentage (0–100), confirmed live.
  const direct = pickNum(w, ["utilization", "percent", "percentage", "used_pct", "usedPct"]);
  if (direct !== undefined) return clampPct(direct);
  // Fallback for a remaining/limit shape: that ratio is a fraction → ×100.
  const remaining = pickNum(w, ["remaining"]);
  const limit = pickNum(w, ["limit", "total", "max"]);
  if (remaining !== undefined && limit && limit > 0) return clampPct((1 - remaining / limit) * 100);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findWindow(body: any, names: string[]): any {
  if (!body || typeof body !== "object") return undefined;
  for (const n of names) if (body[n] !== undefined) return body[n];
  for (const c of ["usage", "limits", "rate_limits", "data", "result"]) {
    const inner = body[c];
    if (inner && typeof inner === "object") {
      for (const n of names) if (inner[n] !== undefined) return inner[n];
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resetMs(w: any): number | undefined {
  const r = w && typeof w === "object" ? (w.resets_at ?? w.resetsAt) : undefined;
  if (typeof r === "string") {
    const t = Date.parse(r);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function parseAnthropicUsage(body: unknown): {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  fiveHourResetMs?: number;
  weeklyResetMs?: number;
} {
  const five = findWindow(body, ["five_hour", "fiveHour", "5h", "five_hour_limit", "primary"]);
  const week = findWindow(body, [
    "seven_day",
    "sevenDay",
    "7d",
    "weekly",
    "week",
    "seven_day_limit",
    "secondary",
  ]);
  return {
    fiveHourPct: windowPct(five),
    weeklyPct: windowPct(week),
    fiveHourResetMs: resetMs(five),
    weeklyResetMs: resetMs(week),
  };
}

/** Providers the user can authenticate + switch between in the UI. */
const PROVIDER_CATALOG: Array<{ id: string; name: string; authType: "key" | "oauth" }> = [
  { id: "anthropic", name: "Claude (Anthropic)", authType: "oauth" },
  { id: "google", name: "Gemini (Google)", authType: "oauth" },
  { id: "opencode", name: "Opencode", authType: "key" },
  { id: "openai", name: "OpenAI", authType: "key" },
];

export class PiSessionManager implements ConnectorManager {
  private sessions = new Map<string, AgentSession>();
  private cwd: string;
  public readonly authStorage: AuthStorage;
  public readonly modelRegistry: ModelRegistry;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  /**
   * Get or create a session by frontend session id.
   * - If options.sessionFile is set, opens that file.
   * - Else if options.continueRecent, opens the most recent session for cwd (creates new if none).
   * - Else creates a new persistent session.
   */
  async getOrCreateSession(
    sessionId: string,
    options: { sessionFile?: string; continueRecent?: boolean } = {},
  ): Promise<AgentLike> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing as unknown as AgentLike;

    let sessionManager;
    if (options.sessionFile) {
      sessionManager = SessionManager.open(options.sessionFile);
    } else if (options.continueRecent) {
      // continueRecent falls back to a new session when none exist
      try {
        sessionManager = SessionManager.continueRecent(this.cwd);
      } catch {
        sessionManager = SessionManager.create(this.cwd);
      }
    } else {
      sessionManager = SessionManager.create(this.cwd);
    }

    const { session } = await createAgentSession({
      cwd: this.cwd,
      sessionManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    this.sessions.set(sessionId, session);
    return session as unknown as AgentLike;
  }

  getSession(sessionId: string): AgentLike | undefined {
    return this.sessions.get(sessionId) as unknown as AgentLike | undefined;
  }

  /**
   * Anthropic account usage limits (5-hour + weekly). Queries Anthropic with
   * the stored OAuth bearer token. Endpoint is undocumented and overridable via
   * MCA_ANTHROPIC_USAGE_URL; returns nulls (never throws) when unavailable.
   */
  async getAccountUsage(options: { debug?: boolean } = {}): Promise<AccountUsage> {
    const result: AccountUsage = { fiveHourPct: null, weeklyPct: null };
    let token: string | undefined;
    try {
      token = await this.authStorage.getApiKey("anthropic");
    } catch {
      /* ignore */
    }
    if (!token) {
      if (options.debug) result.debug = { url: "", status: null, error: "no anthropic token" };
      return result;
    }
    const url = process.env.MCA_ANTHROPIC_USAGE_URL || "https://api.anthropic.com/api/oauth/usage";
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      if (!res.ok) {
        result.rateLimited = res.status === 429;
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) result.retryAfterMs = ra * 1000;
      }
      const parsed = parseAnthropicUsage(body);
      result.fiveHourPct = parsed.fiveHourPct;
      result.weeklyPct = parsed.weeklyPct;
      if (parsed.fiveHourResetMs || parsed.weeklyResetMs) {
        result.resetsAt = { fiveHourMs: parsed.fiveHourResetMs, weeklyMs: parsed.weeklyResetMs };
      }
      if (options.debug) {
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        result.debug = { url, status: res.status, body, headers };
      }
    } catch (err) {
      if (options.debug) result.debug = { url, status: null, error: String(err) };
    }
    return result;
  }

  /** Change the active model on an existing session. */
  async setSessionModel(sessionId: string, provider: string, modelId: string): Promise<AgentModel> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const model = this.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model ${provider}/${modelId} not found`);

    await session.setModel(model);
    return { id: model.id, name: model.name, provider: model.provider };
  }

  /** Change the thinking level on an existing session. */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setThinkingLevel(level);
  }

  /**
   * Set the session's display name. Persists a `session_info` entry to the
   * session file, so the name also surfaces in the persisted-session list
   * (Sessions screen) on the next `list()`.
   */
  setSessionName(sessionId: string, name: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setSessionName(name);
    return session.sessionName ?? name;
  }

  listActiveSessions(): ActiveSessionInfo[] {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      model: session.model?.id,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      messageCount: session.messages.length,
    }));
  }

  /** List persisted session files for the current cwd. */
  async listPersistedSessions(): Promise<PersistedSessionDescriptor[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any[] = await (SessionManager as any).list(this.cwd);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (raw || []).map((entry: any) => ({
        id: entry.id || entry.sessionId || entry.path || String(entry),
        path: entry.path || entry.filePath || entry.file || "",
        name: entry.name || entry.displayName || entry.title || "Untitled",
        modifiedAt: entry.modifiedAt || entry.mtime || entry.updatedAt || Date.now(),
        messageCount: entry.messageCount,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Delete a persisted session file from disk. Disposes any in-memory session
   * currently backed by that file first so we don't write it back out.
   */
  async deletePersistedSession(sessionFile: string): Promise<void> {
    if (!sessionFile) throw new Error("sessionFile is required");
    for (const [id, session] of this.sessions) {
      if (session.sessionFile === sessionFile) {
        this.disposeSession(id);
      }
    }
    await unlink(sessionFile);
  }

  /** Replace the session on a given id with one opened from a file. */
  async resumeSession(sessionId: string, sessionFile: string): Promise<AgentLike> {
    this.disposeSession(sessionId);
    return this.getOrCreateSession(sessionId, { sessionFile });
  }

  /** Replace the session on a given id with a fresh new one. */
  async newSession(sessionId: string): Promise<AgentLike> {
    this.disposeSession(sessionId);
    return this.getOrCreateSession(sessionId);
  }

  async getAvailableModels(): Promise<AvailableModel[]> {
    const models = await this.modelRegistry.getAvailable();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
    }));
  }

  /** Model providers the user can switch between + whether they're authed. */
  listProviders(): ProviderInfo[] {
    return PROVIDER_CATALOG.map((p) => {
      let authenticated = false;
      try {
        authenticated = this.authStorage.hasAuth(p.id);
      } catch {
        /* treat as not authenticated */
      }
      return { ...p, authenticated };
    });
  }

  /** Store an API key for a provider; its models then appear in the picker. */
  setProviderApiKey(id: string, key: string): void {
    this.authStorage.set(id, { type: "api_key", key });
    this.modelRegistry.refresh();
  }

  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.dispose();
      } catch {
        /* best effort */
      }
      this.sessions.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const [, session] of this.sessions) {
      try {
        session.dispose();
      } catch {
        /* best effort */
      }
    }
    this.sessions.clear();
  }
}
