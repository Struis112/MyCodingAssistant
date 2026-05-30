// Types shared across the chat surface. Lives in a dedicated module so both
// the runtime helpers and the React components can import without dragging
// JSX into a `.ts` file.

/**
 * Single content block on a persisted AgentMessage. Server-side the SDK
 * returns these with a handful of `type` values: "text", "thinking",
 * "toolCall". We type them loosely because the wire payload is `any`.
 */
export interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** A persisted message restored from disk via `chat:resumed`. */
export interface RawMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

/** Top-of-chat filter toggles. Drives both header chip and per-item rendering. */
export interface MessageFilters {
  assistant: boolean;
  thinking: boolean;
  tool: boolean;
  system: boolean;
}
