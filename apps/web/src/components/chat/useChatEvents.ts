"use client";

import { useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { generateId } from "@/lib/utils";
import { agentMessagesToChatItems } from "./agentMessages";
import type { RawMessage } from "./types";

/**
 * Subscribe (once) to the server's chat-event stream and route every event to
 * the session it belongs to (`data.sessionId`) — NOT just the active tab. That
 * routing is what lets background tabs stream live and raise an unread badge.
 *
 * Per-session item/streaming state lives in the store keyed by session id; the
 * streaming-cursor (which assistant item is receiving deltas) is the store's
 * `currentAssistantId` per session. Handlers read the latest store via
 * `getState()` so the subscription is stable (no re-subscribe on tab switch).
 */
export function useChatEvents() {
  useEffect(() => {
    const socket = getSocket();
    const store = () => useAppStore.getState();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (data: { sessionId: string; event: any }) => {
      const sid = data.sessionId;
      const ev = data.event;
      if (!sid || !ev || typeof ev !== "object") return;
      const s = store();

      // ---- assistant message lifecycle ----
      if (ev.type === "message_start" && ev.message?.role === "assistant") {
        const id = generateId();
        s.setCurrentAssistantId(sid, id);
        s.addItem(sid, {
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
        const currentId = s.getCurrentAssistantId(sid);
        if (!sub || !currentId) return;

        const appendToLastBlock = (blockType: "text" | "thinking", delta: string) => {
          s.updateItem(sid, currentId, (it) => {
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
          s.updateItem(sid, currentId, (it) =>
            it.kind === "assistant"
              ? {
                  ...it,
                  blocks: it.blocks.map((b) =>
                    b.type === blockType && b.isStreaming ? { ...b, isStreaming: false } : b,
                  ),
                }
              : it,
          );
        };

        switch (sub.type) {
          case "text_start":
            s.updateItem(sid, currentId, (it) =>
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
            s.updateItem(sid, currentId, (it) =>
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
        const currentId = s.getCurrentAssistantId(sid);
        if (currentId) {
          s.updateItem(sid, currentId, (it) =>
            it.kind === "assistant" ? { ...it, isStreaming: false } : it,
          );
        }
        s.setCurrentAssistantId(sid, null);
        return;
      }

      // ---- tool execution lifecycle ----
      if (ev.type === "tool_execution_start") {
        if (s.findToolItemByCallId(sid, ev.toolCallId)) return;
        s.addItem(sid, {
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
        const existing = s.findToolItemByCallId(sid, ev.toolCallId);
        if (!existing || existing.kind !== "tool") return;
        s.updateItem(sid, existing.id, (it) =>
          it.kind === "tool" ? { ...it, result: ev.partialResult } : it,
        );
        return;
      }

      if (ev.type === "tool_execution_end") {
        const existing = s.findToolItemByCallId(sid, ev.toolCallId);
        if (!existing || existing.kind !== "tool") return;
        s.updateItem(sid, existing.id, (it) =>
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
      const s = store();
      s.setStreaming(data.sessionId, false);
      const cur = s.getCurrentAssistantId(data.sessionId);
      if (cur) {
        s.updateItem(data.sessionId, cur, (it) =>
          it.kind === "assistant" ? { ...it, isStreaming: false } : it,
        );
        s.setCurrentAssistantId(data.sessionId, null);
      }
    };

    const onError = (data: { sessionId: string; error: string }) => {
      const s = store();
      s.addItem(data.sessionId, {
        kind: "system",
        id: generateId(),
        text: `Error: ${data.error}`,
        timestamp: Date.now(),
      });
      s.setStreaming(data.sessionId, false);
    };

    const onResumed = (data: {
      sessionId: string;
      sessionFile?: string;
      name?: string | null;
      messages?: RawMessage[];
    }) => {
      const s = store();
      s.setSessionFileFor(data.sessionId, data.sessionFile);
      s.renameTab(data.sessionId, data.name ?? null);
      s.setItems(data.sessionId, agentMessagesToChatItems(data.messages || []));
    };

    const onState = (data: {
      sessionId: string;
      state: null | {
        sessionFile?: string;
        name?: string | null;
        isStreaming?: boolean;
        messages?: RawMessage[];
      };
    }) => {
      const st = data.state;
      if (!st) return;
      const s = store();
      if (st.sessionFile) s.setSessionFileFor(data.sessionId, st.sessionFile);
      if (st.name !== undefined) s.renameTab(data.sessionId, st.name ?? null);
      const msgs = st.messages;
      if (!msgs || msgs.length === 0) return;
      const haveItems = (s.sessions[data.sessionId]?.items.length ?? 0) > 0;
      // Reconcile from the server's persisted state on (re)connect: load it when
      // we have nothing, OR when the server is NOT mid-stream. The latter repairs
      // a turn that a restart interrupted — no stuck "streaming…" items, and the
      // full saved detail of what happened is shown.
      if (!haveItems || st.isStreaming === false) {
        s.setItems(data.sessionId, agentMessagesToChatItems(msgs));
        s.setStreaming(data.sessionId, !!st.isStreaming);
        if (!st.isStreaming) s.setCurrentAssistantId(data.sessionId, null);
      }
    };

    const onNew = (data: { sessionId: string; sessionFile?: string; name?: string | null }) => {
      const s = store();
      s.setSessionFileFor(data.sessionId, data.sessionFile);
      s.renameTab(data.sessionId, data.name ?? null);
      s.clearItems(data.sessionId);
    };

    const onInfo = (data: { sessionId: string; sessionFile?: string; name?: string | null }) => {
      const s = store();
      if (data.sessionFile) s.setSessionFileFor(data.sessionId, data.sessionFile);
      if (data.name !== undefined) s.renameTab(data.sessionId, data.name ?? null);
    };

    const onNameChanged = (data: { sessionId: string; name: string }) => {
      const s = store();
      s.renameTab(data.sessionId, data.name);
      s.addItem(data.sessionId, {
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
    socket.on("session:info", onInfo);
    socket.on("session:nameChanged", onNameChanged);

    return () => {
      socket.off("chat:event", onEvent);
      socket.off("chat:done", onDone);
      socket.off("chat:error", onError);
      socket.off("chat:resumed", onResumed);
      socket.off("chat:state:result", onState);
      socket.off("chat:new", onNew);
      socket.off("session:info", onInfo);
      socket.off("session:nameChanged", onNameChanged);
    };
  }, []);
}
