// Global state management with Zustand
import { create } from 'zustand';

export type View = 'chat' | 'dashboard' | 'settings' | 'avatar' | 'camera' | 'logs' | 'sessions';

// ----- Chat items -----
//
// The chat is a chronological list of items. An item is either a user
// message, an assistant message (with text + thinking blocks), a tool
// execution (with args/result), or a system note.
//
// This matches the Pi SDK's event stream cleanly: each AssistantMessageEvent
// or tool_execution_* event maps to a block/item update.

export type ContentBlock =
  | { type: 'text'; text: string; isStreaming?: boolean }
  | { type: 'thinking'; text: string; isStreaming?: boolean };

export type ChatItem =
  | { kind: 'user'; id: string; text: string; timestamp: number }
  | {
      kind: 'assistant';
      id: string;
      blocks: ContentBlock[];
      timestamp: number;
      isStreaming: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      status: 'running' | 'success' | 'error';
      timestamp: number;
    }
  | { kind: 'system'; id: string; text: string; timestamp: number };

export interface ServiceStatus {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  uptime?: number;
  restartCount: number;
  enabled: boolean;
  cpu?: number;
  memory?: number;
  port?: number;
  lastError?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface PersistedSession {
  id: string;
  path: string;
  name: string;
  modifiedAt: number;
  messageCount?: number;
}

interface AppState {
  // View
  activeView: View;
  setActiveView: (view: View) => void;

  // Chat items
  items: ChatItem[];
  addItem: (item: ChatItem) => void;
  updateItem: (id: string, update: (item: ChatItem) => ChatItem) => void;
  findItem: (id: string) => ChatItem | undefined;
  findToolItemByCallId: (toolCallId: string) => ChatItem | undefined;
  clearItems: () => void;
  setItems: (items: ChatItem[]) => void;

  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;

  // Session
  sessionId: string;
  setSessionId: (id: string) => void;
  sessionFile: string | undefined;
  setSessionFile: (path: string | undefined) => void;

  // Persisted session list
  persistedSessions: PersistedSession[];
  setPersistedSessions: (sessions: PersistedSession[]) => void;

  // Model
  currentModel: ModelInfo | null;
  setCurrentModel: (model: ModelInfo | null) => void;

  // Services
  services: ServiceStatus[];
  setServices: (services: ServiceStatus[]) => void;
  updateService: (name: string, status: Partial<ServiceStatus>) => void;

  // Connection
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // View
  activeView: 'chat',
  setActiveView: (view) => set({ activeView: view }),

  // Chat items
  items: [],
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
  updateItem: (id, update) =>
    set((state) => ({
      items: state.items.map((it) => (it.id === id ? update(it) : it)),
    })),
  findItem: (id) => get().items.find((it) => it.id === id),
  findToolItemByCallId: (toolCallId) =>
    get().items.find((it) => it.kind === 'tool' && it.toolCallId === toolCallId),
  clearItems: () => set({ items: [] }),
  setItems: (items) => set({ items }),

  isStreaming: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),

  // Session
  sessionId: 'default',
  setSessionId: (id) => set({ sessionId: id }),
  sessionFile: undefined,
  setSessionFile: (path) => set({ sessionFile: path }),

  // Persisted session list
  persistedSessions: [],
  setPersistedSessions: (sessions) => set({ persistedSessions: sessions }),

  // Model
  currentModel: null,
  setCurrentModel: (model) => set({ currentModel: model }),

  // Services
  services: [],
  setServices: (services) => set({ services }),
  updateService: (name, status) =>
    set((state) => ({
      services: state.services.map((s) => (s.name === name ? { ...s, ...status } : s)),
    })),

  // Connection
  isConnected: false,
  setIsConnected: (connected) => set({ isConnected: connected }),
}));
