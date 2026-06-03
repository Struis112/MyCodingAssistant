import { describe, expect, it, vi } from "vitest";
import { CommitTrigger } from "./commit-trigger.js";

/** Drive checkOnce() over a scripted sequence of ref shas. */
function makeTrigger(shas: Array<string | null>) {
  const seq = [...shas];
  const onCommit = vi.fn();
  const trigger = new CommitTrigger({
    poll: async () => (seq.length ? seq.shift()! : null),
    onCommit,
  });
  return { trigger, onCommit };
}

describe("CommitTrigger", () => {
  it("does not fire on the baseline (first observed commit)", async () => {
    const { trigger, onCommit } = makeTrigger(["A"]);
    const fired = await trigger.checkOnce();
    expect(fired).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(trigger.lastSeen).toBe("A");
  });

  it("fires once per new commit, ignoring unchanged polls", async () => {
    const { trigger, onCommit } = makeTrigger(["A", "A", "B", "B", "C"]);
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await trigger.checkOnce());

    // A=baseline(false), A=unchanged(false), B=fire(true), B=unchanged(false), C=fire(true)
    expect(results).toEqual([false, false, true, false, true]);
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual(["B", "C"]);
  });

  it("ignores null (unresolved ref) until a real commit appears", async () => {
    const { trigger, onCommit } = makeTrigger([null, null, "A", "B"]);
    for (let i = 0; i < 4; i++) await trigger.checkOnce();
    // First real sha A is the baseline; B fires.
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual(["B"]);
  });
});
