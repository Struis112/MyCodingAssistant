// Translate the persisted AgentMessage[] payload (delivered with `chat:resumed`)
// into the ChatItem[] shape the renderer expects. Pure data transform — no
// React, no socket, no globals.

import type { ChatItem, ContentBlock } from "@/lib/store";
import { generateId } from "@/lib/utils";
import type { RawContentBlock, RawMessage } from "./types";

/** Concatenate all text-typed entries from a `content` field (array or string). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as RawContentBlock).type === "text")
      .map((c) => (c as RawContentBlock).text || "")
      .join("");
  }
  return "";
}

/**
 * Convert a list of restored AgentMessage[] into ChatItem[]. Tool results
 * are folded into their owning toolCall item by id.
 */
export function agentMessagesToChatItems(messages: RawMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of messages || []) {
    const ts = msg.timestamp || Date.now();
    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) items.push({ kind: "user", id: generateId(), text, timestamp: ts });
    } else if (msg.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const content = Array.isArray(msg.content) ? (msg.content as RawContentBlock[]) : [];
      for (const c of content) {
        if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
        else if (c.type === "thinking" && c.thinking)
          blocks.push({ type: "thinking", text: c.thinking });
        else if (c.type === "toolCall" && c.id && c.name) {
          items.push({
            kind: "tool",
            id: generateId(),
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            status: "success",
            timestamp: ts,
          });
        }
      }
      if (blocks.length > 0) {
        items.push({
          kind: "assistant",
          id: generateId(),
          blocks,
          timestamp: ts,
          isStreaming: false,
        });
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const target = items.find((it) => it.kind === "tool" && it.toolCallId === msg.toolCallId);
      if (target && target.kind === "tool") {
        target.result = msg.content;
        target.isError = !!msg.isError;
        target.status = msg.isError ? "error" : "success";
      }
    }
  }
  return items;
}
