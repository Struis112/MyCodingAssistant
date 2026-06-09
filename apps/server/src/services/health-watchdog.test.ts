import { describe, expect, it, vi } from "vitest";
import { HealthWatchdog, type RepairNeeded } from "./health-watchdog.js";
import type { LogLine, ServiceState, ServiceStatus } from "./service-supervisor.js";

function status(name: string, state: ServiceState): ServiceStatus {
  return { name, description: name, state, restarts: 0, maxRestarts: 50, hotReloadEnabled: false };
}

const logs: LogLine[] = [{ ts: 1, stream: "err", text: "boom" }];

/** A controllable clock that only advances when we tell it to. */
function fixedClock(start = 0) {
  let t = start;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  return { now, advance };
}

function setup(statuses: () => ServiceStatus[], clock = fixedClock(), opts = {}) {
  const onRepairNeeded = vi.fn<(r: RepairNeeded) => void>();
  const wd = new HealthWatchdog({
    getStatuses: statuses,
    getLogs: () => logs,
    onRepairNeeded,
    debounceMs: 5_000,
    cooldownMs: 60_000,
    now: clock.now,
    ...opts,
  });
  return { wd, onRepairNeeded, clock };
}

describe("HealthWatchdog", () => {
  it("does not fire for healthy services", () => {
    const { wd, onRepairNeeded } = setup(() => [status("web", "running")]);
    wd.check();
    expect(onRepairNeeded).not.toHaveBeenCalled();
  });

  it("waits out the debounce before asking for repair", () => {
    const clock = fixedClock();
    let state: ServiceState = "failed";
    const { wd, onRepairNeeded } = setup(() => [status("web", state)], clock);

    wd.check(); // first sighting — starts the timer, no emit
    expect(onRepairNeeded).not.toHaveBeenCalled();

    clock.advance(3_000);
    wd.check(); // still within debounce
    expect(onRepairNeeded).not.toHaveBeenCalled();

    clock.advance(3_000); // now 6s ≥ 5s debounce
    wd.check();
    expect(onRepairNeeded).toHaveBeenCalledTimes(1);
    const req = onRepairNeeded.mock.calls[0]![0];
    expect(req.service).toBe("web");
    expect(req.state).toBe("failed");
    expect(req.logs).toEqual(logs);
    void state;
  });

  it("does not re-notify within the cooldown, then notifies again after it", () => {
    const clock = fixedClock();
    const { wd, onRepairNeeded } = setup(() => [status("web", "failed")], clock);

    wd.check();
    clock.advance(6_000);
    wd.check(); // first emit
    expect(onRepairNeeded).toHaveBeenCalledTimes(1);

    clock.advance(30_000);
    wd.check(); // within 60s cooldown
    expect(onRepairNeeded).toHaveBeenCalledTimes(1);

    clock.advance(40_000); // > 60s since the emit
    wd.check();
    expect(onRepairNeeded).toHaveBeenCalledTimes(2);
  });

  it("resets when a service recovers, so a later failure notifies again", () => {
    const clock = fixedClock();
    let state: ServiceState = "failed";
    const { wd, onRepairNeeded } = setup(() => [status("web", state)], clock);

    wd.check();
    clock.advance(6_000);
    wd.check();
    expect(onRepairNeeded).toHaveBeenCalledTimes(1);

    // Recovered.
    state = "running";
    wd.check();

    // Fails again later — fresh episode, notifies after debounce despite the
    // earlier cooldown.
    state = "failed";
    wd.check();
    clock.advance(6_000);
    wd.check();
    expect(onRepairNeeded).toHaveBeenCalledTimes(2);
  });

  it("honors a custom unhealthy-state set (e.g. backoff)", () => {
    const clock = fixedClock();
    const { wd, onRepairNeeded } = setup(() => [status("web", "backoff")], clock, {
      unhealthyStates: ["failed", "backoff"] as ServiceState[],
    });
    wd.check();
    clock.advance(6_000);
    wd.check();
    expect(onRepairNeeded).toHaveBeenCalledTimes(1);
  });
});
