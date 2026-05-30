// Global state management with Zustand
import { create } from "zustand";

// ----- localStorage helpers -----
//
// User preferences (model + thinking level) live here so they survive
// both browser reloads and server restarts. On AppShell mount we push
// these prefs to the fresh server session.

export function readString(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeString(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

// Read user prefs out of localStorage. Call from a useEffect after mount
// — never from a Zustand initial state or anything that runs during SSR.
export function readPersistedUserPrefs(): {
  currentModel: ModelInfo | null;
  thinkingLevel: string;
} {
  return {
    currentModel: readJSON<ModelInfo | null>("mca-model", null),
    thinkingLevel: readString("mca-thinking-level", "off"),
  };
}

export type View = "chat" | "sessions" | "settings";

// ----- Chat items -----
//
// The chat is a chronological list of items. An item is either a user
// message, an assistant message (with text + thinking blocks), a tool
// execution (with args/result), or a system note.
//
// This matches the Pi SDK's event stream cleanly: each AssistantMessageEvent
// or tool_execution_* event maps to a block/item update.

export type ContentBlock =
  | { type: "text"; text: string; isStreaming?: boolean }
  | { type: "thinking"; text: string; isStreaming?: boolean };

export type ChatItem =
  | { kind: "user"; id: string; text: string; timestamp: number }
  | {
      kind: "assistant";
      id: string;
      blocks: ContentBlock[];
      timestamp: number;
      isStreaming: boolean;
    }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      status: "running" | "success" | "error";
      timestamp: number;
    }
  | { kind: "system"; id: string; text: string; timestamp: number };

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

  // Thinking level (shared between Settings and the chat header)
  thinkingLevel: string;
  setThinkingLevel: (level: string) => void;

  // Connection
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),

  items: [],
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
  updateItem: (id, update) =>
    set((state) => ({
      items: state.items.map((it) => (it.id === id ? update(it) : it)),
    })),
  findItem: (id) => get().items.find((it) => it.id === id),
  findToolItemByCallId: (toolCallId) => get().items.find((it) => it.kind === "tool" && it.toolCallId === toolCallId),
  clearItems: () => set({ items: [] }),
  setItems: (items) => set({ items }),

  isStreaming: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),

  sessionId: "default",
  setSessionId: (id) => set({ sessionId: id }),
  sessionFile: undefined,
  setSessionFile: (path) => set({ sessionFile: path }),

  persistedSessions: [],
  setPersistedSessions: (sessions) => set({ persistedSessions: sessions }),

  // SSR-safe defaults. localStorage is read in AppShell's mount effect via
  // hydrateUserPrefs() so the server snapshot and the client's first render
  // always agree (avoids the hydration-mismatch in the chat header).
  currentModel: null,
  setCurrentModel: (model) => {
    writeJSON("mca-model", model);
    set({ currentModel: model });
  },

  thinkingLevel: "off",
  setThinkingLevel: (level) => {
    writeString("mca-thinking-level", level);
    set({ thinkingLevel: level });
  },

  isConnected: false,
  setIsConnected: (connected) => set({ isConnected: connected }),
}));
