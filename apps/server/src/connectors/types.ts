// Connector contract.
//
// A "connector" plugs the chat UI into a specific coding-agent harness
// (Pi SDK, Claude Code, Opencode Go, …). Each connector exposes a
// `ConnectorManager` with the session lifecycle the WebSocket + REST
// handlers actually use, and a per-session `AgentLike` capturing the
// minimum surface the handlers touch at runtime.
//
// Today there's exactly one connector (Pi). The point of factoring it
// out is to keep handlers.ts / routes.ts from importing the Pi SDK
// directly, so adding additional harnesses later is purely additive.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Minimal model descriptor we report back to the frontend. */
export interface AgentModel {
  id: string;
  name: string;
  provider: string;
}

/** Per-session surface the WebSocket handlers consume. */
export interface AgentLike {
  /** True while the agent is currently producing assistant output. */
  readonly isStreaming: boolean;
  /** Restored message history (shape depends on the harness; passed through). */
  readonly messages: readonly unknown[];
  /** Path of the persisted session file on disk, if any. */
  readonly sessionFile: string | undefined;
  /** Harness-native session id. */
  readonly sessionId: string;
  /** User-defined display name for the session, if set. */
  readonly sessionName: string | undefined;
  readonly model: AgentModel | null | undefined;
  readonly thinkingLevel: string;

  /** Subscribe to the harness's normalized event stream; returns unsubscribe. */
  subscribe(cb: (event: unknown) => void): () => void;

  /** Send a fresh prompt. The harness must be idle. */
  prompt(text: string, options?: unknown): Promise<unknown>;
  /** Inject a steering message into the currently-running turn. */
  steer(text: string): Promise<unknown>;
  /** Queue a message to deliver when the agent next becomes idle. */
  followUp(text: string): Promise<unknown>;
  /** Cancel the current turn, if any. */
  abort(): Promise<void>;

  setThinkingLevel(level: ThinkingLevel): void;

  /** Set the session's display name (persists to the session file). */
  setSessionName(name: string): void;

  /** Release any resources tied to this session. */
  dispose(): void;
}

export interface ActiveSessionInfo {
  id: string;
  sessionFile: string | undefined;
  sessionId: string;
  model: string | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
}

export interface PersistedSessionDescriptor {
  id: string;
  path: string;
  name: string;
  modifiedAt: number;
  messageCount?: number;
}

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

/** Lifecycle and metadata operations the handlers / REST routes invoke. */
/** Account-level usage limits (e.g. Anthropic's 5-hour + weekly windows). */
export interface AccountUsage {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  resetsAt?: { fiveHourMs?: number; weeklyMs?: number };
  /** Upstream rate-limited this fetch (HTTP 429). */
  rateLimited?: boolean;
  /** Suggested backoff from the upstream `retry-after` header, in ms. */
  retryAfterMs?: number;
  /** Debug-only upstream details, to help finalize the endpoint/parsing. */
  debug?: {
    url: string;
    status: number | null;
    body?: unknown;
    error?: string;
    headers?: Record<string, string>;
  };
}

/** A model provider the user can authenticate + switch between (Claude/Gemini/…). */
export interface ProviderInfo {
  id: string;
  name: string;
  /** "key" → paste an API key in-app; "oauth" → sign in via `pi /login`. */
  authType: "key" | "oauth";
  authenticated: boolean;
}

export interface ConnectorManager {
  /**
   * Optional: report account usage limits (5-hour + weekly). Not every
   * connector/provider supports this; returns nulls when unavailable.
   */
  getAccountUsage?(options?: { debug?: boolean }): Promise<AccountUsage>;
  /** Optional: list model providers + their auth status. */
  listProviders?(): ProviderInfo[];
  /** Optional: store an API key for a provider (then its models appear). */
  setProviderApiKey?(id: string, key: string): void;
  getOrCreateSession(
    sessionId: string,
    options?: { sessionFile?: string; continueRecent?: boolean },
  ): Promise<AgentLike>;
  getSession(sessionId: string): AgentLike | undefined;

  setSessionModel(sessionId: string, provider: string, modelId: string): Promise<AgentModel>;
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void;
  /** Set the session display name; returns the resolved name. */
  setSessionName(sessionId: string, name: string): string;

  listActiveSessions(): ActiveSessionInfo[];
  listPersistedSessions(): Promise<PersistedSessionDescriptor[]>;
  /** Delete a persisted session file from disk. */
  deletePersistedSession(sessionFile: string): Promise<void>;

  resumeSession(sessionId: string, sessionFile: string): Promise<AgentLike>;
  newSession(sessionId: string): Promise<AgentLike>;

  getAvailableModels(): Promise<AvailableModel[]>;

  disposeSession(sessionId: string): void;
  disposeAll(): void;
}

/**
 * Bundles a manager with the metadata the UI needs to identify and label
 * the harness behind it. Future phases will let the frontend pick which
 * connector backs a given session.
 */
export interface Connector {
  /** Stable, machine-readable id (e.g. "pi", "claude-code", "opencode-go"). */
  readonly id: string;
  /** Human-readable display name shown in the UI. */
  readonly name: string;
  /** Lazy session lifecycle + state for this harness. */
  readonly manager: ConnectorManager;
}
