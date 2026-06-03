"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { generateId } from "@/lib/utils";
import { agentMessagesToChatItems } from "./agentMessages";
import type { RawMessage } from "./types";

/**
 * Subscribe to the server's chat-event stream and translate every
 * AgentSessionEvent into ChatItem updates on the global store.
 *
 * The wire payload `event` is intentionally typed loosely (`any` underneath
 * an unknown-cast) because it comes straight from the Pi SDK's
 * AgentSessionEvent discriminated union, and pulling that type in here
 * would couple the web bundle to SDK internals it otherwise doesn't need.
 *
 * Side-effects this hook manages:
 *   - assistant message lifecycle (message_start / message_update *_delta /
 *     message_end), including the streaming-cursor flag on each block
 *   - tool execution lifecycle (tool_execution_start / _update / _end)
 *   - chat:done — finalises any lingering streaming flags
 *   - chat:error — appends a system item with the error text
 *   - chat:resumed — replaces the items with the rehydrated history
 *   - chat:new — clears the items list
 */
export function useChatEvents() {
  const {
    addItem,
    updateItem,
    findToolItemByCallId,
    clearItems,
    setItems,
    setIsStreaming,
    sessionId,
    setSessionFile,
    setSessionName,
  } = useAppStore();

  // Holds the id of the currently-streaming assistant item so deltas can
  // be appended to it across many events without searching the array.
  const currentAssistantIdRef = useRef<string | null>(null);

  useEffect(() => {
    const socket = getSocket();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (data: { sessionId: string; event: any }) => {
      if (data.sessionId !== sessionId) return;
      const ev = data.event;
      if (!ev || typeof ev !== "object") return;

      // ---- assistant message lifecycle ----
      if (ev.type === "message_start" && ev.message?.role === "assistant") {
        const id = generateId();
        currentAssistantIdRef.current = id;
        addItem({
          kind: "assistant",
          id,
          blocks: [],
          timestamp: Date.now(),
          isStreaming: true,
        });
        return;
      }

      if (ev.type === "message_update") {
        const sub = ev.assistantMessageEvent;
        const currentId = currentAssistantIdRef.current;
        if (!sub || !currentId) return;

        const appendToLastBlock = (blockType: "text" | "thinking", delta: string) => {
          updateItem(currentId, (it) => {
            if (it.kind !== "assistant") return it;
            const blocks = [...it.blocks];
            let idx = -1;
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i].type === blockType) {
                idx = i;
                break;
              }
            }
            if (idx === -1) {
              blocks.push({ type: blockType, text: delta, isStreaming: true });
            } else {
              const b = blocks[idx] as {
                type: typeof blockType;
                text: string;
                isStreaming?: boolean;
              };
              blocks[idx] = { type: blockType, text: b.text + delta, isStreaming: true };
            }
            return { ...it, blocks };
          });
        };

        const finishBlock = (blockType: "text" | "thinking") => {
          updateItem(currentId, (it) => {
            if (it.kind !== "assistant") return it;
            const blocks = it.blocks.map((b) =>
              b.type === blockType && b.isStreaming ? { ...b, isStreaming: false } : b,
            );
            return { ...it, blocks };
          });
        };

        switch (sub.type) {
          case "text_start":
            updateItem(currentId, (it) =>
              it.kind === "assistant"
                ? { ...it, blocks: [...it.blocks, { type: "text", text: "", isStreaming: true }] }
                : it,
            );
            return;
          case "text_delta":
            appendToLastBlock("text", sub.delta || "");
            return;
          case "text_end":
            finishBlock("text");
            return;
          case "thinking_start":
            updateItem(currentId, (it) =>
              it.kind === "assistant"
                ? {
                    ...it,
                    blocks: [...it.blocks, { type: "thinking", text: "", isStreaming: true }],
                  }
                : it,
            );
            return;
          case "thinking_delta":
            appendToLastBlock("thinking", sub.delta || "");
            return;
          case "thinking_end":
            finishBlock("thinking");
            return;
        }
        return;
      }

      if (ev.type === "message_end") {
        const currentId = currentAssistantIdRef.current;
        if (currentId) {
          updateItem(currentId, (it) =>
            it.kind === "assistant" ? { ...it, isStreaming: false } : it,
          );
        }
        currentAssistantIdRef.current = null;
        return;
      }

      // ---- tool execution lifecycle ----
      if (ev.type === "tool_execution_start") {
        if (findToolItemByCallId(ev.toolCallId)) return;
        addItem({
          kind: "tool",
          id: generateId(),
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args,
          status: "running",
          timestamp: Date.now(),
        });
        return;
      }

      if (ev.type === "tool_execution_update") {
        const existing = findToolItemByCallId(ev.toolCallId);
        if (!existing || existing.kind !== "tool") return;
        updateItem(existing.id, (it) =>
          it.kind === "tool" ? { ...it, result: ev.partialResult } : it,
        );
        return;
      }

      if (ev.type === "tool_execution_end") {
        const existing = findToolItemByCallId(ev.toolCallId);
        if (!existing || existing.kind !== "tool") return;
        updateItem(existing.id, (it) =>
          it.kind === "tool"
            ? {
                ...it,
                result: ev.result,
                isError: !!ev.isError,
                status: ev.isError ? "error" : "success",
              }
            : it,
        );
        return;
      }
    };

    const onDone = (data: { sessionId: string }) => {
      if (data.sessionId !== sessionId) return;
      setIsStreaming(false);
      // Defensive: any lingering streaming blocks get finalized
      const current = currentAssistantIdRef.current;
      if (current) {
        updateItem(current, (it) => (it.kind === "assistant" ? { ...it, isStreaming: false } : it));
        currentAssistantIdRef.current = null;
      }
    };

    const onError = (data: { sessionId: string; error: string }) => {
      if (data.sessionId !== sessionId) return;
      addItem({
        kind: "system",
        id: generateId(),
        text: `Error: ${data.error}`,
        timestamp: Date.now(),
      });
      setIsStreaming(false);
    };

    const onResumed = (data: {
      sessionId: string;
      sessionFile?: string;
      name?: string | null;
      messages?: RawMessage[];
    }) => {
      if (data.sessionId !== sessionId) return;
      setSessionFile(data.sessionFile);
      setSessionName(data.name ?? null);
      const restored = agentMessagesToChatItems(data.messages || []);
      setItems(restored);
    };

    // chat:state:result is the server's answer to the chat:state we send on
    // every (re)connect. After a server restart or a plain browser reload the
    // local item list is empty while the server holds the persisted history,
    // so rehydrate from it. Guard on an empty list so a reconnect during an
    // active chat can't clobber in-flight items.
    const onState = (data: {
      sessionId: string;
      state: null | { sessionFile?: string; name?: string | null; messages?: RawMessage[] };
    }) => {
      if (data.sessionId !== sessionId) return;
      const st = data.state;
      if (!st) return;
      if (st.sessionFile) setSessionFile(st.sessionFile);
      if (st.name !== undefined) setSessionName(st.name ?? null);
      const msgs = st.messages;
      if (msgs && msgs.length > 0 && useAppStore.getState().items.length === 0) {
        setItems(agentMessagesToChatItems(msgs));
      }
    };

    const onNew = (data: { sessionId: string; sessionFile?: string; name?: string | null }) => {
      if (data.sessionId !== sessionId) return;
      setSessionFile(data.sessionFile);
      setSessionName(data.name ?? null);
      clearItems();
    };

    const onNameChanged = (data: { sessionId: string; name: string }) => {
      if (data.sessionId !== sessionId) return;
      setSessionName(data.name);
      addItem({
        kind: "system",
        id: generateId(),
        text: `Renamed session to “${data.name}”.`,
        timestamp: Date.now(),
      });
    };

    socket.on("chat:event", onEvent);
    socket.on("chat:done", onDone);
    socket.on("chat:error", onError);
    socket.on("chat:resumed", onResumed);
    socket.on("chat:state:result", onState);
    socket.on("chat:new", onNew);
    socket.on("session:nameChanged", onNameChanged);

    return () => {
      socket.off("chat:event", onEvent);
      socket.off("chat:done", onDone);
      socket.off("chat:error", onError);
      socket.off("chat:resumed", onResumed);
      socket.off("chat:state:result", onState);
      socket.off("chat:new", onNew);
      socket.off("session:nameChanged", onNameChanged);
    };
  }, [
    sessionId,
    addItem,
    updateItem,
    findToolItemByCallId,
    setIsStreaming,
    setItems,
    clearItems,
    setSessionFile,
    setSessionName,
  ]);
}
