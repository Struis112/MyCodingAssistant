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
    // eslint-disable-next-line no-await-in-loop
    for (let i = 0; i < 5; i++) results.push(await trigger.checkOnce());

    // A=baseline(false), A=unchanged(false), B=fire(true), B=unchanged(false), C=fire(true)
    expect(results).toEqual([false, false, true, false, true]);
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual(["B", "C"]);
  });

  it("ignores null (unresolved ref) until a real commit appears", async () => {
    const { trigger, onCommit } = makeTrigger([null, null, "A", "B"]);
    // eslint-disable-next-line no-await-in-loop
    for (let i = 0; i < 4; i++) await trigger.checkOnce();
    // First real sha A is the baseline; B fires.
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual(["B"]);
  });

  describe("quiet-period coalescing (quietMs)", () => {
    function makeQuiet(
      shas: (string | null)[],
      times: number[],
      quietMs: number,
      maxWaitMs = 600_000,
    ) {
      const onCommit = vi.fn();
      let i = 0;
      let t = 0;
      const trigger = new CommitTrigger({
        poll: () => Promise.resolve(shas[Math.min(i, shas.length - 1)] ?? null),
        now: () => t,
        quietMs,
        maxWaitMs,
        onCommit,
      });
      const step = async (advanceTo: number) => {
        t = advanceTo;
        const r = await trigger.checkOnce();
        i++;
        return r;
      };
      void times;
      return { trigger, onCommit, step };
    }

    it("coalesces a burst into one fire with the latest sha", async () => {
      const { onCommit, step } = makeQuiet(["A", "B", "C", "C", "C"], [], 100);
      await step(0); // baseline A
      await step(10); // B queued
      await step(20); // C arrives -> quiet timer extends
      await step(60); // still quiet < 100ms since last change
      expect(onCommit).not.toHaveBeenCalled();
      await step(130); // 110ms after C -> fires once with C
      expect(onCommit.mock.calls.map((c) => c[0])).toEqual(["C"]);
    });

    it("max-wait cap fires even under a steady commit stream", async () => {
      const shas = ["A", "B", "C", "D", "E", "F"];
      const { onCommit, step } = makeQuiet(shas, [], 1_000, 250);
      await step(0); // baseline A
      await step(100); // B queued (first at 100)
      await step(200); // C — keeps resetting quiet
      await step(300); // D
      await step(400); // E — 300ms past first: cap (250) exceeded -> fires E
      expect(onCommit.mock.calls.map((c) => c[0])).toEqual(["E"]);
    });
  });
});
