// Pi SDK Session Manager
// Wraps @earendil-works/pi-coding-agent for persistent, multi-session use.
// Sessions live on disk in ~/.pi/agent/sessions/ so the assistant resumes
// across server restarts.

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

export interface SessionInfo {
  id: string;
  sessionFile: string | undefined;
  sessionId: string;
  model: string | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
}

export interface SessionFile {
  id: string;
  path: string;
  name: string;
  modifiedAt: number;
  messageCount?: number;
}

export class PiSessionManager {
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
  ): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

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
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Change the active model on an existing session. */
  async setSessionModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<{ id: string; name: string; provider: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const model = this.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model ${provider}/${modelId} not found`);

    await session.setModel(model);
    return { id: model.id, name: model.name, provider: model.provider };
  }

  /** Change the thinking level on an existing session. */
  setSessionThinkingLevel(
    sessionId: string,
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setThinkingLevel(level);
  }

  listActiveSessions(): SessionInfo[] {
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
  async listPersistedSessions(): Promise<SessionFile[]> {
    try {
      const raw: any[] = await (SessionManager as any).list(this.cwd);
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

  /** Replace the session on a given id with one opened from a file. */
  async resumeSession(sessionId: string, sessionFile: string): Promise<AgentSession> {
    this.disposeSession(sessionId);
    return this.getOrCreateSession(sessionId, { sessionFile });
  }

  /** Replace the session on a given id with a fresh new one. */
  async newSession(sessionId: string): Promise<AgentSession> {
    this.disposeSession(sessionId);
    return this.getOrCreateSession(sessionId);
  }

  async getAvailableModels() {
    const models = await this.modelRegistry.getAvailable();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      contextWindow: m.contextWindow,
      reasoning: m.reasoning,
    }));
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
