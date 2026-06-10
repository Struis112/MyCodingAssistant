import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRestartGate } from "./watch-safe-restarter.js";

describe("createRestartGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restarts after the debounce when idle", () => {
    const onRestart = vi.fn();
    const gate = createRestartGate({ activeTurns: () => 0, onRestart, debounceMs: 400 });
    gate.notifyChange();
    expect(onRestart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(onRestart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(gate.isSpent()).toBe(true);
  });

  it("collapses a burst of changes into a single restart", () => {
    const onRestart = vi.fn();
    const gate = createRestartGate({ activeTurns: () => 0, onRestart, debounceMs: 400 });
    gate.notifyChange();
    vi.advanceTimersByTime(200);
    gate.notifyChange();
    vi.advanceTimersByTime(200);
    gate.notifyChange(); // keeps resetting the debounce
    vi.advanceTimersByTime(399);
    expect(onRestart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("waits while a turn is streaming, then restarts once idle", () => {
    let active = 2;
    const onRestart = vi.fn();
    const gate = createRestartGate({
      activeTurns: () => active,
      onRestart,
      debounceMs: 400,
      idlePollMs: 1_000,
    });
    gate.notifyChange();
    vi.advanceTimersByTime(400); // debounce fires -> first idle check (busy)
    expect(onRestart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000); // still busy across polls
    expect(onRestart).not.toHaveBeenCalled();
    active = 0; // turn finished
    vi.advanceTimersByTime(1_000); // next poll sees idle
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("never fires more than once even with later changes", () => {
    const onRestart = vi.fn();
    const gate = createRestartGate({ activeTurns: () => 0, onRestart, debounceMs: 100 });
    gate.notifyChange();
    vi.advanceTimersByTime(100);
    expect(onRestart).toHaveBeenCalledTimes(1);
    gate.notifyChange();
    vi.advanceTimersByTime(1_000);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("force-restarts after maxWaitMs if a turn is stuck streaming", () => {
    const onRestart = vi.fn();
    const gate = createRestartGate({
      activeTurns: () => 1, // never idle
      onRestart,
      debounceMs: 400,
      idlePollMs: 1_000,
      maxWaitMs: 5_000,
    });
    gate.notifyChange();
    vi.advanceTimersByTime(400); // debounce -> busy
    vi.advanceTimersByTime(4_000); // still within maxWait
    expect(onRestart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000); // crosses maxWait -> force restart
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
