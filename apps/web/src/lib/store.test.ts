import { beforeEach, describe, expect, it } from "vitest";
import {
  readJSON,
  readPersistedUserPrefs,
  readString,
  useAppStore,
  writeJSON,
  writeString,
  type ChatItem,
} from "./store";

// Pristine per-session state we reset to between tests.
const PRISTINE = {
  activeView: "chat" as const,
  sessions: {
    default: {
      id: "default",
      name: null as string | null,
      sessionFile: undefined as string | undefined,
      items: [] as ChatItem[],
      isStreaming: false,
      unread: false,
      currentAssistantId: null as string | null,
      title: "",
      draft: "",
    },
  },
  tabOrder: ["default"],
  activeSessionId: "default",
  pendingNewTab: false,
  persistedSessions: [] as ReturnType<typeof useAppStore.getState>["persistedSessions"],
  currentModel: null as ReturnType<typeof useAppStore.getState>["currentModel"],
  isConnected: false,
};

function resetStore() {
  useAppStore.setState(PRISTINE);
}

const activeItems = () => {
  const s = useAppStore.getState();
  return s.sessions[s.activeSessionId]!.items;
};

describe("useAppStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("view", () => {
    it("starts on chat", () => {
      expect(useAppStore.getState().activeView).toBe("chat");
    });
    it("setActiveView switches", () => {
      useAppStore.getState().setActiveView("settings");
      expect(useAppStore.getState().activeView).toBe("settings");
    });
  });

  describe("persisted sessions", () => {
    it("starts empty", () => {
      expect(useAppStore.getState().persistedSessions).toEqual([]);
    });
    it("setPersistedSessions replaces the list", () => {
      useAppStore
        .getState()
        .setPersistedSessions([{ id: "a", path: "/tmp/a.json", name: "A", modifiedAt: 1 }]);
      expect(useAppStore.getState().persistedSessions).toHaveLength(1);
    });
  });

  describe("chat items (per session)", () => {
    it("starts empty", () => {
      expect(activeItems()).toEqual([]);
    });

    it("addItem appends to the target session in order", () => {
      const { addItem } = useAppStore.getState();
      addItem("default", { kind: "user", id: "u1", text: "hi", timestamp: 1 });
      addItem("default", {
        kind: "assistant",
        id: "a1",
        blocks: [{ type: "text", text: "hello" }],
        timestamp: 2,
        isStreaming: false,
      });
      expect(activeItems().map((i) => i.id)).toEqual(["u1", "a1"]);
    });

    it("updateItem replaces in place", () => {
      const { addItem, updateItem } = useAppStore.getState();
      addItem("default", {
        kind: "assistant",
        id: "a1",
        blocks: [{ type: "text", text: "hel", isStreaming: true }],
        timestamp: 1,
        isStreaming: true,
      });
      updateItem("default", "a1", (item) =>
        item.kind === "assistant"
          ? { ...item, blocks: [{ type: "text", text: "hello", isStreaming: false }] }
          : item,
      );
      const it1 = activeItems()[0];
      expect(it1?.kind === "assistant" && it1.blocks[0]).toEqual({
        type: "text",
        text: "hello",
        isStreaming: false,
      });
    });

    it("findToolItemByCallId locates a tool item by its toolCallId", () => {
      const { addItem, findToolItemByCallId } = useAppStore.getState();
      addItem("default", {
        kind: "tool",
        id: "t1",
        toolCallId: "call_abc",
        toolName: "read",
        args: {},
        status: "running",
        timestamp: 1,
      });
      expect(findToolItemByCallId("default", "call_abc")?.id).toBe("t1");
      expect(findToolItemByCallId("default", "nope")).toBeUndefined();
    });

    it("clearItems empties one session", () => {
      const { addItem, clearItems } = useAppStore.getState();
      addItem("default", { kind: "user", id: "u1", text: "hi", timestamp: 1 });
      clearItems("default");
      expect(activeItems()).toEqual([]);
    });
  });

  describe("tabs (multi-session)", () => {
    it("openTab creates a new active, empty tab", () => {
      const id = useAppStore.getState().openTab();
      const s = useAppStore.getState();
      expect(s.activeSessionId).toBe(id);
      expect(s.tabOrder).toContain(id);
      expect(s.pendingNewTab).toBe(true);
      expect(s.sessions[id]!.items).toEqual([]);
    });

    it("addItem to a background session raises its unread badge; switching clears it", () => {
      const bg = useAppStore.getState().openTab(); // active = bg
      useAppStore.getState().switchTab("default"); // active = default
      useAppStore.getState().addItem(bg, { kind: "system", id: "x", text: "done", timestamp: 1 });
      expect(useAppStore.getState().sessions[bg]!.unread).toBe(true);
      useAppStore.getState().switchTab(bg);
      expect(useAppStore.getState().sessions[bg]!.unread).toBe(false);
    });

    it("closeTab removes it and moves focus to a neighbor", () => {
      const a = useAppStore.getState().openTab();
      useAppStore.getState().closeTab(a);
      const s = useAppStore.getState();
      expect(s.tabOrder).not.toContain(a);
      expect(s.sessions[a]).toBeUndefined();
      expect(s.activeSessionId).toBe("default");
    });

    it("never closes the last tab", () => {
      useAppStore.getState().closeTab("default");
      expect(useAppStore.getState().tabOrder).toEqual(["default"]);
    });
  });

  describe("setDraft (per-tab composer)", () => {
    it("stores draft text on the targeted session only", () => {
      const other = useAppStore.getState().openTab(); // active = other
      useAppStore.getState().setDraft("default", "hello from default");
      useAppStore.getState().setDraft(other, "hello from other");
      const s = useAppStore.getState();
      expect(s.sessions.default!.draft).toBe("hello from default");
      expect(s.sessions[other]!.draft).toBe("hello from other");
    });
    it("is a no-op for an unknown session id (doesn't crash or create one)", () => {
      useAppStore.getState().setDraft("nope", "x");
      expect(useAppStore.getState().sessions.nope).toBeUndefined();
    });
  });

  describe("applyServerTabs (cross-device tab sync)", () => {
    it("creates new tabs for unknown sessionFiles, preserves order, keeps the local default tab at the end", () => {
      useAppStore.getState().applyServerTabs([
        { sessionFile: "/s/a.jsonl", name: "A" },
        { sessionFile: "/s/b.jsonl", name: null },
      ]);
      const s = useAppStore.getState();
      const files = s.tabOrder.map((id) => s.sessions[id]!.sessionFile ?? null);
      // Server tabs first (in order), then the local-only default tab.
      expect(files).toEqual(["/s/a.jsonl", "/s/b.jsonl", null]);
      // Active tab is preserved when it still exists after reconciliation.
      expect(s.activeSessionId).toBe("default");
    });

    it("reuses existing tab ids for a known sessionFile (keeps loaded items)", () => {
      // Seed a tab that already has the file we're about to reconcile against.
      useAppStore.getState().setSessionFile("/s/a.jsonl");
      useAppStore
        .getState()
        .addItem("default", { kind: "user", id: "u1", text: "hi", timestamp: 1 });
      const beforeId = useAppStore.getState().activeSessionId;
      useAppStore.getState().applyServerTabs([{ sessionFile: "/s/a.jsonl", name: "renamed" }]);
      const s = useAppStore.getState();
      expect(s.tabOrder).toEqual([beforeId]);
      expect(s.sessions[beforeId]!.items.map((i) => i.id)).toEqual(["u1"]);
      expect(s.sessions[beforeId]!.name).toBe("renamed");
    });

    it("drops file-tabs missing from the server list but keeps local-only tabs", () => {
      // Two file-backed tabs from the server, then a local-only new tab.
      useAppStore.getState().applyServerTabs([
        { sessionFile: "/s/a.jsonl", name: "A" },
        { sessionFile: "/s/b.jsonl", name: "B" },
      ]);
      const localOnly = useAppStore.getState().openTab(); // no sessionFile
      // Server now reports only A.
      useAppStore.getState().applyServerTabs([{ sessionFile: "/s/a.jsonl", name: "A" }]);
      const s = useAppStore.getState();
      const files = s.tabOrder.map((id) => s.sessions[id]!.sessionFile ?? null);
      // File-tab B is dropped; local-only tabs (the original default + the new
      // one we opened) both survive, appended after the kept file-tabs.
      expect(files).toEqual(["/s/a.jsonl", null, null]);
      expect(s.tabOrder).toContain(localOnly);
      expect(s.tabOrder).toContain("default");
    });

    it("falls back to a default tab when the server list is empty and nothing local remains", () => {
      useAppStore.getState().setSessionFile("/s/a.jsonl"); // turn the default tab into a file-tab
      useAppStore.getState().applyServerTabs([]);
      const s = useAppStore.getState();
      expect(s.tabOrder).toEqual(["default"]);
      expect(s.sessions.default!.sessionFile).toBeUndefined();
      expect(s.activeSessionId).toBe("default");
    });
  });

  describe("active session fields", () => {
    it("setSessionFile/setSessionName mutate the active tab", () => {
      useAppStore.getState().setSessionFile("/tmp/foo.jsonl");
      useAppStore.getState().setSessionName("My chat");
      const s = useAppStore.getState();
      expect(s.sessions.default!.sessionFile).toBe("/tmp/foo.jsonl");
      expect(s.sessions.default!.name).toBe("My chat");
    });

    it("setStreaming toggles a session", () => {
      useAppStore.getState().setStreaming("default", true);
      expect(useAppStore.getState().sessions.default!.isStreaming).toBe(true);
    });
  });
});

describe("localStorage helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("readString / writeString", () => {
    it("writes and reads strings", () => {
      writeString("k", "v");
      expect(readString("k", "fallback")).toBe("v");
    });
    it("returns the fallback when the key is missing", () => {
      expect(readString("missing", "fallback")).toBe("fallback");
    });
  });

  describe("readJSON / writeJSON", () => {
    it("round-trips JSON-serializable values", () => {
      writeJSON("obj", { a: 1, b: ["x", "y"] });
      expect(readJSON("obj", null)).toEqual({ a: 1, b: ["x", "y"] });
    });
    it("returns the fallback when the key is missing", () => {
      expect(readJSON("missing", { fallback: true })).toEqual({ fallback: true });
    });
    it("returns the fallback when stored data is corrupt JSON", () => {
      window.localStorage.setItem("corrupt", "{ not json");
      expect(readJSON("corrupt", "fallback")).toBe("fallback");
    });
  });

  describe("readPersistedUserPrefs", () => {
    it("returns the documented defaults when localStorage is empty", () => {
      const prefs = readPersistedUserPrefs();
      expect(prefs.currentModel).toBeNull();
      expect(prefs.thinkingLevel).toBe("off");
    });
    it("reads currentModel + thinkingLevel from their keys", () => {
      const model = { id: "x", name: "X", provider: "anthropic" };
      writeJSON("mca-model", model);
      writeString("mca-thinking-level", "high");
      const prefs = readPersistedUserPrefs();
      expect(prefs.currentModel).toEqual(model);
      expect(prefs.thinkingLevel).toBe("high");
    });
  });
});
