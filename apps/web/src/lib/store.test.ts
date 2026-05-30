import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore, type ChatItem } from "./store";

// Snapshot of pristine state we reset to between tests so each one starts
// from the documented defaults regardless of order.
const PRISTINE = {
  activeView: "chat" as const,
  items: [] as ChatItem[],
  isStreaming: false,
  sessionId: "default",
  sessionFile: undefined as string | undefined,
  persistedSessions: [] as ReturnType<typeof useAppStore.getState>["persistedSessions"],
  currentModel: null as ReturnType<typeof useAppStore.getState>["currentModel"],
  isConnected: false,
};

function resetStore() {
  useAppStore.setState(PRISTINE);
}

describe("useAppStore", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("view", () => {
    it("starts on chat", () => {
      expect(useAppStore.getState().activeView).toBe("chat");
    });

    it("setActiveView switches", () => {
      useAppStore.getState().setActiveView("sessions");
      expect(useAppStore.getState().activeView).toBe("sessions");

      useAppStore.getState().setActiveView("settings");
      expect(useAppStore.getState().activeView).toBe("settings");
    });
  });

  describe("chat items", () => {
    it("starts empty", () => {
      expect(useAppStore.getState().items).toEqual([]);
    });

    it("addItem appends in order", () => {
      const { addItem } = useAppStore.getState();
      addItem({ kind: "user", id: "u1", text: "hi", timestamp: 1 });
      addItem({
        kind: "assistant",
        id: "a1",
        blocks: [{ type: "text", text: "hello" }],
        timestamp: 2,
        isStreaming: false,
      });

      const items = useAppStore.getState().items;
      expect(items).toHaveLength(2);
      expect(items[0]!.id).toBe("u1");
      expect(items[1]!.id).toBe("a1");
    });

    it("findItem locates by id", () => {
      const { addItem, findItem } = useAppStore.getState();
      addItem({ kind: "user", id: "u1", text: "hi", timestamp: 1 });
      addItem({ kind: "system", id: "s1", text: "note", timestamp: 2 });

      expect(findItem("u1")?.id).toBe("u1");
      expect(findItem("s1")?.kind).toBe("system");
      expect(findItem("nope")).toBeUndefined();
    });

    it("updateItem replaces in place", () => {
      const { addItem, updateItem } = useAppStore.getState();
      addItem({
        kind: "assistant",
        id: "a1",
        blocks: [{ type: "text", text: "hel", isStreaming: true }],
        timestamp: 1,
        isStreaming: true,
      });

      updateItem("a1", (item) => {
        if (item.kind !== "assistant") return item;
        return { ...item, blocks: [{ type: "text", text: "hello", isStreaming: false }] };
      });

      const it1 = useAppStore.getState().findItem("a1");
      expect(it1).toBeDefined();
      if (it1?.kind === "assistant") {
        expect(it1.blocks[0]).toEqual({
          type: "text",
          text: "hello",
          isStreaming: false,
        });
      }
    });

    it("updateItem is a no-op for unknown id", () => {
      const { addItem, updateItem } = useAppStore.getState();
      addItem({ kind: "user", id: "u1", text: "hi", timestamp: 1 });
      updateItem("does-not-exist", (item) => item);
      expect(useAppStore.getState().items).toHaveLength(1);
    });

    it("findToolItemByCallId locates a tool item by its toolCallId", () => {
      const { addItem, findToolItemByCallId } = useAppStore.getState();
      addItem({ kind: "user", id: "u1", text: "hi", timestamp: 1 });
      addItem({
        kind: "tool",
        id: "t1",
        toolCallId: "call_abc",
        toolName: "read",
        args: { path: "foo" },
        status: "running",
        timestamp: 2,
      });

      const found = findToolItemByCallId("call_abc");
      expect(found?.id).toBe("t1");
      expect(findToolItemByCallId("call_unknown")).toBeUndefined();
    });

    it("clearItems empties the list", () => {
      const { addItem, clearItems } = useAppStore.getState();
      addItem({ kind: "user", id: "u1", text: "hi", timestamp: 1 });
      addItem({ kind: "system", id: "s1", text: "n", timestamp: 2 });
      clearItems();
      expect(useAppStore.getState().items).toEqual([]);
    });
  });

  describe("session", () => {
    it('defaults to "default" session id and no file', () => {
      const s = useAppStore.getState();
      expect(s.sessionId).toBe("default");
      expect(s.sessionFile).toBeUndefined();
    });

    it("setSessionId + setSessionFile update independently", () => {
      const { setSessionId, setSessionFile } = useAppStore.getState();
      setSessionId("abc");
      setSessionFile("/tmp/foo.jsonl");
      const s = useAppStore.getState();
      expect(s.sessionId).toBe("abc");
      expect(s.sessionFile).toBe("/tmp/foo.jsonl");
    });
  });

  describe("streaming flag", () => {
    it("toggles", () => {
      expect(useAppStore.getState().isStreaming).toBe(false);
      useAppStore.getState().setIsStreaming(true);
      expect(useAppStore.getState().isStreaming).toBe(true);
      useAppStore.getState().setIsStreaming(false);
      expect(useAppStore.getState().isStreaming).toBe(false);
    });
  });
});
