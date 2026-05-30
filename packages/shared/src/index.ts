// Shared types for MyCodingAssistant

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export interface ServiceStatus {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  uptime?: number;
  restartCount: number;
  enabled: boolean;
  cpu?: number;
  memory?: number;
}

export interface SessionInfo {
  id: string;
  model: string | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messageCount: number;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
}

// WebSocket event types
export type WebSocketEvent =
  | { type: 'chat:send'; sessionId: string; message: string }
  | { type: 'chat:abort'; sessionId: string }
  | { type: 'chat:event'; sessionId: string; event: any }
  | { type: 'chat:done'; sessionId: string }
  | { type: 'chat:error'; sessionId: string; error: string }
  | { type: 'services:list' }
  | { type: 'services:start'; name: string }
  | { type: 'services:stop'; name: string }
  | { type: 'services:status'; services: ServiceStatus[] }
  | { type: 'services:update'; name: string; status: string };

// Service configuration
export interface ServiceConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  autoRestart?: boolean;
  maxRestarts?: number;
  restartDelayMs?: number;
}

// Theme types
export type Theme = 'light' | 'dark';

export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  'card-foreground': string;
  muted: string;
  'muted-foreground': string;
  accent: string;
  'accent-foreground': string;
  primary: string;
  'primary-foreground': string;
  border: string;
  ring: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}
