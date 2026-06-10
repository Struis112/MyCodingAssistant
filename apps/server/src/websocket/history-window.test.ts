import { describe, expect, it } from "vitest";
import { tailWindowStart, prevWindowStart, isUserMessage } from "./history-window.js";

const u = (n: number) => ({ role: "user", content: `q${n}` });
const a = (n: number) => ({ role: "assistant", content: `a${n}` });
const t = () => ({ role: "toolResult", toolCallId: "x" });

describe("history windowing", () => {
  // 12 messages: u0 a0 u1 a1 t u2 a2 u3 a3 u4 a4 u5  (6 user turns)
  const msgs = [u(0), a(0), u(1), a(1), t(), u(2), a(2), u(3), a(3), u(4), a(4), u(5)];

  it("isUserMessage matches only role=user", () => {
    expect(isUserMessage(u(0))).toBe(true);
    expect(isUserMessage(a(0))).toBe(false);
    expect(isUserMessage(null)).toBe(false);
  });

  it("tail window starts at the Nth user message from the end", () => {
    expect(tailWindowStart(msgs, 5)).toBe(2); // u1 at index 2
    expect(tailWindowStart(msgs, 1)).toBe(11); // u5
    expect(tailWindowStart(msgs, 99)).toBe(0); // fewer turns than asked -> all
  });

  it("prev window walks back N user turns before `before`", () => {
    const start = tailWindowStart(msgs, 5); // 2
    expect(prevWindowStart(msgs, start, 5)).toBe(0); // only u0 remains
    expect(prevWindowStart(msgs, 11, 2)).toBe(7); // u3
    expect(prevWindowStart(msgs, 0, 5)).toBe(0);
  });

  it("never splits a toolResult from its turn (windows cut at user messages)", () => {
    const start = tailWindowStart(msgs, 4); // u2 at index 5; toolResult at 4 stays older side
    expect(start).toBe(5);
    expect(isUserMessage(msgs[start])).toBe(true);
  });
});
