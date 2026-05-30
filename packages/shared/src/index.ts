// Shared types for MyCodingAssistant

export interface SessionInfo {
  id: string;
  sessionFile: string | undefined;
  sessionId: string;
  model: string | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
}

export interface PersistedSession {
  id: string;
  path: string;
  name: string;
  modifiedAt: number;
  messageCount?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

// Theme types
export type Theme = "light" | "dark";
