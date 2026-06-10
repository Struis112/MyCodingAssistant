// Chat history windowing
//
// A long session (900+ messages) must not be shipped whole on every
// chat:state — it makes tab open/switch slow. Instead the server sends the
// tail window (the last TAIL_TURNS user turns and everything after them) plus
// { offset, total }, and the client asks for earlier windows on demand
// (chat:history). Windows are cut at USER-message boundaries so a toolCall
// and its toolResult (which always live between user messages) are never
// split across a window edge.

export const TAIL_TURNS = 5;

export function isUserMessage(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { role?: unknown }).role === "user";
}

/**
 * Index where the tail window starts: the `turns`-th user message counting
 * from the end (0 when there are fewer user messages than `turns`).
 */
export function tailWindowStart(messages: readonly unknown[], turns: number = TAIL_TURNS): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserMessage(messages[i])) {
      count++;
      if (count === turns) return i;
    }
  }
  return 0;
}

/**
 * Index where the PREVIOUS window starts: `turns` user messages before
 * `before` (exclusive). 0 when fewer remain.
 */
export function prevWindowStart(
  messages: readonly unknown[],
  before: number,
  turns: number = TAIL_TURNS,
): number {
  let count = 0;
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    if (isUserMessage(messages[i])) {
      count++;
      if (count === turns) return i;
    }
  }
  return 0;
}
