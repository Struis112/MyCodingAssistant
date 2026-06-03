// vitest hoists vi.mock(...) above imports.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnedChildren: FakeChild[] = [];

class FakeChild extends EventEmitter {
  pid: number;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((sig?: string) => {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, sig ?? "SIGTERM"));
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild(10_000 + spawnedChildren.length);
    spawnedChildren.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }),
}));

// fs.watch stub: captures the change callbacks so tests can simulate a file
// change and drive the hot-reload / validation-gate path.
const { watchCallbacks } = vi.hoisted(() => ({
  watchCallbacks: [] as Array<(event: string, file: string) => void>,
}));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    watch: vi.fn((_p: any, _o: any, cb: any) => {
      if (typeof cb === "function") watchCallbacks.push(cb);
      return { close: vi.fn() };
    }),
  };
});

/** Simulate a source change on every active watcher. */
function triggerChange(file = "changed.ts"): void {
  for (const cb of watchCallbacks) cb("change", file);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { ServiceSupervisor } = await import("./service-supervisor.js");

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    name: "test",
    description: "test service",
    port: 3000,
    resolveCommand: () => ({ command: "node", args: ["x.js"], cwd: "/tmp", env: {} }),
    restartIntervalMs: 1_000,
    maxRestarts: 3,
    ...overrides,
  };
}

beforeEach(() => {
  spawnedChildren.length = 0;
  watchCallbacks.length = 0;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ServiceSupervisor — initial + start", () => {
  it("starts in 'stopped' state", () => {
    const sup = new ServiceSupervisor(baseSpec());
    expect(sup.getStatus().state).toBe("stopped");
  });

  it("spawns and transitions starting -> running", async () => {
    const sup = new ServiceSupervisor(baseSpec());
    await sup.start();
    await flush();
    const status = sup.getStatus();
    expect(status.state).toBe("running");
    expect(status.pid).toBe(spawnedChildren[0]!.pid);
    expect(status.port).toBe(3000);
    await sup.stop();
  });

  it("is idempotent — second start() while running is a no-op", async () => {
    const sup = new ServiceSupervisor(baseSpec());
    await sup.start();
    await flush();
    await sup.start();
    await flush();
    expect(spawnedChildren).toHaveLength(1);
    await sup.stop();
  });

  it("fails preflight with a reason and does not spawn", async () => {
    const sup = new ServiceSupervisor(
      baseSpec({ preflight: async () => ({ ok: false, reason: "port busy" }) }),
    );
    await sup.start();
    await flush();
    expect(spawnedChildren).toHaveLength(0);
    const status = sup.getStatus();
    expect(status.state).toBe("failed");
    expect(status.lastError).toMatch(/port busy/);
  });
});

describe("ServiceSupervisor — crash recovery (fixed 1/min, capped)", () => {
  it("schedules a restart at the fixed interval on crash", async () => {
    vi.useFakeTimers();
    const sup = new ServiceSupervisor(baseSpec({ restartIntervalMs: 60_000 }));
    await sup.start();
    await flush();

    spawnedChildren[0]!.emit("exit", 1, null);
    await flush();

    const after = sup.getStatus();
    expect(after.state).toBe("backoff");
    expect(after.restarts).toBe(1);

    // No restart before the minute is up.
    vi.advanceTimersByTime(59_000);
    await flush();
    expect(spawnedChildren).toHaveLength(1);

    // Fires at 60s.
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(spawnedChildren).toHaveLength(2);
    await sup.stop();
  });

  it("gives up with state=failed after maxRestarts", async () => {
    vi.useFakeTimers();
    const sup = new ServiceSupervisor(baseSpec({ restartIntervalMs: 1_000, maxRestarts: 2 }));
    await sup.start();
    await flush();

    for (let i = 0; i < 3; i++) {
      spawnedChildren[i]?.emit("exit", 1, null);
      // eslint-disable-next-line no-await-in-loop
      await flush();
      vi.advanceTimersByTime(1_000);
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    const status = sup.getStatus();
    expect(status.state).toBe("failed");
    expect(status.lastError).toMatch(/max restarts/i);
  });

  it("runs the repair hook before restarting and records the note", async () => {
    vi.useFakeTimers();
    const repair = vi.fn(async () => ({ repaired: true, note: "rebuilt artifacts" }));
    const sup = new ServiceSupervisor(baseSpec({ restartIntervalMs: 1_000, repair }));
    await sup.start();
    await flush();

    spawnedChildren[0]!.emit("exit", 1, null);
    await flush();
    expect(repair).toHaveBeenCalledOnce();
    expect(sup.getStatus().lastRepair).toMatch(/rebuilt artifacts/);
    await sup.stop();
  });
});

describe("ServiceSupervisor — stop + restart", () => {
  it("kills the child and clears the restart timer", async () => {
    vi.useFakeTimers();
    const sup = new ServiceSupervisor(baseSpec());
    await sup.start();
    await flush();
    const child = spawnedChildren[0]!;
    await sup.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(sup.getStatus().state).toBe("stopped");
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(spawnedChildren).toHaveLength(1);
  });

  it("restart() resets the crash counter and respawns", async () => {
    const sup = new ServiceSupervisor(baseSpec());
    await sup.start();
    await flush();
    await sup.restart();
    await flush();
    expect(spawnedChildren).toHaveLength(2);
    expect(sup.getStatus().restarts).toBe(0);
    await sup.stop();
  });

  it("restart() with a repair hook does not trip crash recovery (regression)", async () => {
    vi.useFakeTimers();
    const repair = vi.fn(async () => ({ repaired: true, note: "should not run" }));
    const sup = new ServiceSupervisor(baseSpec({ repair, restartIntervalMs: 60_000 }));
    await sup.start();
    await flush();

    await sup.restart();
    await flush();

    // The deliberate kill must NOT be treated as a crash: no repair, no backoff,
    // no stray restart timer spawning a duplicate later.
    expect(repair).not.toHaveBeenCalled();
    const status = sup.getStatus();
    expect(status.state).toBe("running");
    expect(status.restarts).toBe(0);
    expect(spawnedChildren).toHaveLength(2);

    vi.advanceTimersByTime(120_000);
    await flush();
    expect(spawnedChildren).toHaveLength(2);
    await sup.stop();
  });
});

describe("ServiceSupervisor — validation gate (deploy contract, Phase 1)", () => {
  it("activates the change when validate passes", async () => {
    const validate = vi.fn(async () => ({ ok: true }));
    const rebuild = vi.fn(async () => {});
    const sup = new ServiceSupervisor(
      baseSpec({ validate, watch: { paths: ["/src"], rebuild, debounceMs: 5 } }),
    );
    await sup.start();
    await flush();
    expect(spawnedChildren).toHaveLength(1);

    triggerChange();
    await sleep(40);
    await flush();

    expect(validate).toHaveBeenCalledOnce();
    expect(rebuild).toHaveBeenCalledOnce();
    // A restart spawned a fresh child to serve the validated change.
    expect(spawnedChildren.length).toBeGreaterThanOrEqual(2);
    await sup.stop();
  });

  it("keeps the current version (no rebuild, no restart) when validate fails", async () => {
    const validate = vi.fn(async () => ({ ok: false, logs: "TS2304: Cannot find name 'foo'" }));
    const rebuild = vi.fn(async () => {});
    const sup = new ServiceSupervisor(
      baseSpec({ validate, watch: { paths: ["/src"], rebuild, debounceMs: 5 } }),
    );
    await sup.start();
    await flush();

    triggerChange();
    await sleep(40);
    await flush();

    expect(validate).toHaveBeenCalledOnce();
    expect(rebuild).not.toHaveBeenCalled();
    // No restart: the original child is still the only one, still running.
    expect(spawnedChildren).toHaveLength(1);
    expect(sup.getStatus().state).toBe("running");
    // The failure is captured for the operator / repair loop.
    expect(sup.getLogs().some((l) => l.text.includes("TS2304"))).toBe(true);
    await sup.stop();
  });
});

describe("ServiceSupervisor — log buffer", () => {
  it("captures stdout/stderr into a bounded ring buffer", async () => {
    const sup = new ServiceSupervisor(baseSpec({ logBufferLines: 5 }));
    await sup.start();
    await flush();
    for (let i = 0; i < 10; i++) spawnedChildren[0]!.stdout.emit("data", `line ${i}\n`);
    const logs = sup.getLogs();
    expect(logs.length).toBeLessThanOrEqual(5);
    expect(logs.at(-1)!.text).toContain("line 9");
    await sup.stop();
  });
});
