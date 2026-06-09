// Global state management with Zustand
import { create } from "zustand";
import { generateId } from "@/lib/utils";

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
  sessionFile: string | undefined;
} {
  return {
    currentModel: readJSON<ModelInfo | null>("mca-model", null),
    thinkingLevel: readString("mca-thinking-level", "off"),
    // Remembered so a reconnect (reload or server restart) restores THIS
    // client's specific conversation, not just the most-recent one.
    sessionFile: readString("mca-session-file", "") || undefined,
  };
}

// ----- Tabs (multi-session) -----

/** One open chat tab. `id` is the logical session id (the socket room key). */
export interface ChatTab {
  id: string;
  name: string | null;
  sessionFile?: string;
}

/** Full in-memory state for one chat session (tab). Items stay resident per
 *  session so background tabs accumulate live and switching is instant. */
export interface SessionState {
  id: string;
  name: string | null;
  sessionFile?: string;
  items: ChatItem[];
  isStreaming: boolean;
  /** New output arrived while this tab was not active (activity badge). */
  unread: boolean;
  /** Id of the assistant item currently receiving streaming deltas. */
  currentAssistantId: string | null;
  /** Tab label derived from the first user message (computed once, not per
   *  token — keeps the tab bar cheap during streaming). */
  title: string;
  /** Per-tab composer draft, so switching tabs doesn't move your typed text. */
  draft: string;
}

function emptySession(id: string, name: string | null = null, sessionFile?: string): SessionState {
  return {
    id,
    name,
    sessionFile,
    draft: "",
    items: [],
    isStreaming: false,
    unread: false,
    currentAssistantId: null,
    title: "",
  };
}

/** First user message, trimmed, as a tab title. "" until one exists. */
function titleFromItems(items: ChatItem[]): string {
  const u = items.find((i) => i.kind === "user");
  if (u && u.kind === "user" && u.text.trim()) {
    const t = u.text.trim().replace(/\s+/g, " ");
    return t.length > 40 ? t.slice(0, 40) : t;
  }
  return "";
}

const TABS_KEY = "mca-tabs";
const ACTIVE_TAB_KEY = "mca-active-tab";

/** Restore the open tabs + active tab from localStorage (call after mount). */
export function readPersistedTabs(): { tabs: ChatTab[]; activeId: string } {
  const tabs = readJSON<ChatTab[]>(TABS_KEY, []);
  if (!tabs.length) return { tabs: [{ id: "default", name: null }], activeId: "default" };
  const stored = readString(ACTIVE_TAB_KEY, "");
  const activeId = tabs.some((t) => t.id === stored) ? stored : tabs[0]!.id;
  return { tabs, activeId };
}

function persistTabs(tabs: ChatTab[], activeId: string): void {
  writeJSON(TABS_KEY, tabs);
  writeString(ACTIVE_TAB_KEY, activeId);
}

export type View = "chat" | "sessions" | "services" | "settings";

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

  // Sessions (multi-tab). `activeSessionId` is the focused tab; `tabOrder`
  // drives the tab bar. Each session keeps its own items so background tabs
  // stream live and switching is instant.
  sessions: Record<string, SessionState>;
  tabOrder: string[];
  activeSessionId: string;
  pendingNewTab: boolean;

  // Per-session chat ops. `sid` is the target session (event routing passes
  // the event's session id; UI passes the active id). Routing by id is what
  // lets a background tab update live.
  addItem: (sid: string, item: ChatItem) => void;
  updateItem: (sid: string, id: string, update: (item: ChatItem) => ChatItem) => void;
  findToolItemByCallId: (sid: string, toolCallId: string) => ChatItem | undefined;
  clearItems: (sid: string) => void;
  setItems: (sid: string, items: ChatItem[]) => void;
  setStreaming: (sid: string, streaming: boolean) => void;
  setCurrentAssistantId: (sid: string, id: string | null) => void;
  getCurrentAssistantId: (sid: string) => string | null;

  // Active-session display fields (mutate the active tab + persist).
  setSessionName: (name: string | null) => void;
  setSessionFile: (path: string | undefined) => void;
  /** Set a specific session's file (event routing may target a background tab). */
  setSessionFileFor: (id: string, file: string | undefined) => void;

  // Tabs
  clearPendingNewTab: () => void;
  openTab: () => string;
  openTabWithFile: (file: string, name?: string | null) => string;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string | null) => void;
  /** Drag-reorder: move `draggedId` to the position of `targetId`. */
  moveTab: (draggedId: string, targetId: string) => void;
  /** Per-tab composer draft text. */
  setDraft: (sid: string, text: string) => void;
  /** Reconcile local tabs with the server's shared (cross-device) tab list. */
  applyServerTabs: (tabs: Array<{ sessionFile: string; name: string | null }>) => void;
  hydrateTabs: (tabs: ChatTab[], activeId: string) => void;

  // Persisted session list (server returns these on `chat:list`).
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

/** Immutably patch one session in the map. No-op if the session is gone. */
function patchSession(
  state: AppState,
  sid: string,
  patch: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>),
): Pick<AppState, "sessions"> {
  const cur = state.sessions[sid];
  if (!cur) return { sessions: state.sessions };
  const p = typeof patch === "function" ? patch(cur) : patch;
  return { sessions: { ...state.sessions, [sid]: { ...cur, ...p } } };
}

/** Persist the tab list + active id derived from the live session map. */
function persistFromState(s: AppState): void {
  const tabs: ChatTab[] = s.tabOrder.map((id) => {
    const ses = s.sessions[id];
    return { id, name: ses?.name ?? null, sessionFile: ses?.sessionFile };
  });
  persistTabs(tabs, s.activeSessionId);
}

export const useAppStore = create<AppState>((set, get) => ({
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),

  // ----- Sessions (multi-tab) -----
  sessions: { default: emptySession("default") },
  tabOrder: ["default"],
  activeSessionId: "default",
  pendingNewTab: false,

  addItem: (sid, item) =>
    set((s) =>
      patchSession(s, sid, (ses) => {
        const items = [...ses.items, item];
        return {
          items,
          // Adding content to a non-focused tab raises its activity badge.
          unread: ses.unread || sid !== s.activeSessionId,
          // Compute the title only until one exists (cheap; not per token).
          title: ses.title || titleFromItems(items),
        };
      }),
    ),
  updateItem: (sid, id, update) =>
    set((s) =>
      patchSession(s, sid, (ses) => ({
        items: ses.items.map((it) => (it.id === id ? update(it) : it)),
      })),
    ),
  findToolItemByCallId: (sid, toolCallId) =>
    get().sessions[sid]?.items.find((it) => it.kind === "tool" && it.toolCallId === toolCallId),
  clearItems: (sid) => set((s) => patchSession(s, sid, { items: [] })),
  setItems: (sid, items) =>
    set((s) => patchSession(s, sid, { items, title: titleFromItems(items) })),
  setStreaming: (sid, streaming) => set((s) => patchSession(s, sid, { isStreaming: streaming })),
  setCurrentAssistantId: (sid, id) => set((s) => patchSession(s, sid, { currentAssistantId: id })),
  getCurrentAssistantId: (sid) => get().sessions[sid]?.currentAssistantId ?? null,

  setSessionFile: (path) => {
    writeString("mca-session-file", path ?? "");
    set((s) => patchSession(s, s.activeSessionId, { sessionFile: path }));
    persistFromState(get());
  },
  setSessionName: (name) => {
    set((s) => patchSession(s, s.activeSessionId, { name }));
    persistFromState(get());
  },
  setSessionFileFor: (id, file) => {
    set((s) => patchSession(s, id, { sessionFile: file }));
    persistFromState(get());
  },

  // ----- Tabs -----
  clearPendingNewTab: () => set({ pendingNewTab: false }),

  openTab: () => {
    const id = generateId();
    set((s) => ({
      sessions: { ...s.sessions, [id]: emptySession(id) },
      tabOrder: [...s.tabOrder, id],
      activeSessionId: id,
      pendingNewTab: true, // AppShell emits chat:new for a fresh session
    }));
    persistFromState(get());
    return id;
  },

  openTabWithFile: (file, name = null) => {
    const existingId = get().tabOrder.find((id) => get().sessions[id]?.sessionFile === file);
    if (existingId) {
      set((s) => ({
        activeSessionId: existingId,
        pendingNewTab: false,
        ...patchSession(s, existingId, { unread: false }),
      }));
      persistFromState(get());
      return existingId;
    }
    const id = generateId();
    set((s) => ({
      sessions: { ...s.sessions, [id]: emptySession(id, name, file) },
      tabOrder: [...s.tabOrder, id],
      activeSessionId: id,
      pendingNewTab: false, // AppShell emits chat:state to restore by file
    }));
    persistFromState(get());
    return id;
  },

  switchTab: (id) => {
    if (!get().sessions[id]) return;
    // Items stay resident, so switching is instant — just focus + clear badge.
    set((s) => ({ activeSessionId: id, ...patchSession(s, id, { unread: false }) }));
    persistFromState(get());
  },

  closeTab: (id) => {
    const s = get();
    if (s.tabOrder.length <= 1) return; // keep at least one tab
    const idx = s.tabOrder.indexOf(id);
    const tabOrder = s.tabOrder.filter((t) => t !== id);
    const sessions = { ...s.sessions };
    delete sessions[id];
    const activeSessionId =
      s.activeSessionId === id ? tabOrder[Math.max(0, idx - 1)]! : s.activeSessionId;
    set({ sessions, tabOrder, activeSessionId });
    persistFromState(get());
  },

  renameTab: (id, name) => {
    set((s) => patchSession(s, id, { name }));
    persistFromState(get());
  },

  moveTab: (draggedId, targetId) => {
    if (draggedId === targetId) return;
    set((s) => {
      const order = [...s.tabOrder];
      const from = order.indexOf(draggedId);
      const to = order.indexOf(targetId);
      if (from === -1 || to === -1) return {};
      order.splice(from, 1);
      order.splice(to, 0, draggedId);
      return { tabOrder: order };
    });
    persistFromState(get());
  },

  setDraft: (sid, text) => set((s) => patchSession(s, sid, { draft: text })),

  applyServerTabs: (serverTabs) => {
    set((s) => {
      const sessions = { ...s.sessions };
      const order: string[] = [];
      // Map each shared (file-backed) tab to a local tab, reusing the existing
      // one for that file (keeps its id + loaded items) or creating it.
      for (const st of serverTabs) {
        let id = s.tabOrder.find((tid) => sessions[tid]?.sessionFile === st.sessionFile);
        if (!id) {
          id = generateId();
          sessions[id] = emptySession(id, st.name ?? null, st.sessionFile);
        } else if (st.name != null && sessions[id]!.name !== st.name) {
          sessions[id] = { ...sessions[id]!, name: st.name };
        }
        if (!order.includes(id)) order.push(id);
      }
      // Keep this device's local-only tabs (new, no file yet) at the end.
      for (const tid of s.tabOrder) {
        if (!order.includes(tid) && !sessions[tid]?.sessionFile) order.push(tid);
      }
      // Drop file-tabs that were closed on another device.
      for (const tid of Object.keys(sessions)) {
        if (!order.includes(tid)) delete sessions[tid];
      }
      let activeSessionId = order.includes(s.activeSessionId) ? s.activeSessionId : order[0];
      if (!activeSessionId) {
        activeSessionId = "default";
        sessions[activeSessionId] = sessions[activeSessionId] ?? emptySession(activeSessionId);
        order.push(activeSessionId);
      }
      return { sessions, tabOrder: order, activeSessionId };
    });
  },

  hydrateTabs: (tabs, activeId) => {
    const sessions: Record<string, SessionState> = {};
    for (const t of tabs) sessions[t.id] = emptySession(t.id, t.name, t.sessionFile);
    const tabOrder = tabs.map((t) => t.id);
    const activeSessionId = sessions[activeId] ? activeId : (tabOrder[0] ?? "default");
    if (!sessions[activeSessionId]) sessions[activeSessionId] = emptySession(activeSessionId);
    set({ sessions, tabOrder: tabOrder.length ? tabOrder : [activeSessionId], activeSessionId });
  },

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
