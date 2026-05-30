// Pi SDK Session Manager
// Wraps @earendil-works/pi-coding-agent to manage multiple sessions

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';

export interface SessionInfo {
  id: string;
  model: string | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
  createdAt: string;
}

export class PiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;

  constructor() {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  async createSession(sessionId: string, cwd?: string): Promise<AgentSession> {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(cwd || process.cwd()),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      model: session.model?.id,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      messageCount: session.messages.length,
      createdAt: new Date().toISOString(),
    }));
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
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const [id, session] of this.sessions) {
      session.dispose();
    }
    this.sessions.clear();
  }
}
