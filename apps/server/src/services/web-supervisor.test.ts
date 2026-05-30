// vitest will hoist this whole file's `vi.mock(...)` calls above the imports.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ----- module mocks -----

const spawnedChildren: FakeChild[] = [];

class FakeChild extends EventEmitter {
  pid: number;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((sig?: string) => {
    this.killed = true;
    // Fire exit asynchronously to mimic real behaviour
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

// fs.existsSync controls the "next binary not found" branch.
let existsSyncReturns = true;
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(() => existsSyncReturns),
  };
});

// Port-in-use probe: pretend the port is free unless a test sets it.
let portInUse = false;
vi.mock("node:net", () => ({
  createConnection: vi.fn(() => {
    const sock = new EventEmitter() as EventEmitter & { destroy: () => void };
    sock.destroy = vi.fn();
    queueMicrotask(() => {
      if (portInUse) sock.emit("connect");
      else sock.emit("error", new Error("ECONNREFUSED"));
    });
    return sock;
  }),
}));

// Import AFTER mocks so the module under test picks them up.
const { WebSupervisor } = await import("./web-supervisor.js");

// ----- helpers -----

async function flushMicrotasks(): Promise<void> {
  // Resolve any queued microtasks (spawn emit, port probe emit, etc.)
  await Promise.resolve();
  await Promise.resolve();
}

async function newSupervisor(overrides: Partial<ConstructorParameters<typeof WebSupervisor>[0]> = {}) {
  return new WebSupervisor({
    webDir: "/fake/web",
    port: 3000,
    baseBackoffMs: 100,
    maxBackoffMs: 800,
    ...overrides,
  });
}

beforeEach(() => {
  spawnedChildren.length = 0;
  existsSyncReturns = true;
  portInUse = false;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ----- tests -----

describe("WebSupervisor — initial state", () => {
  it("starts in 'stopped' state", async () => {
    const sup = await newSupervisor();
    expect(sup.getStatus()).toEqual({ state: "stopped" });
  });
});

describe("WebSupervisor — start()", () => {
  it("spawns a child and transitions starting -> running", async () => {
    const sup = await newSupervisor();
    await sup.start();
    await flushMicrotasks();

    const status = sup.getStatus();
    expect(status.state).toBe("running");
    if (status.state === "running") {
      expect(status.pid).toBe(spawnedChildren[0]!.pid);
      expect(status.port).toBe(3000);
      expect(status.restarts).toBe(0);
    }
    await sup.stop();
  });

  it("is idempotent — second start() while running is a no-op", async () => {
    const sup = await newSupervisor();
    await sup.start();
    await flushMicrotasks();
    await sup.start(); // second call
    await flushMicrotasks();
    expect(spawnedChildren).toHaveLength(1);
    await sup.stop();
  });

  it("refuses to spawn when the port is already in use", async () => {
    portInUse = true;
    const sup = await newSupervisor();
    await sup.start();
    await flushMicrotasks();
    expect(spawnedChildren).toHaveLength(0);
    const status = sup.getStatus();
    expect(status.state).toBe("failed");
    if (status.state === "failed") {
      expect(status.reason).toMatch(/already in use/i);
    }
  });

  it("fails fast when the Next.js binary is missing", async () => {
    existsSyncReturns = false;
    const sup = await newSupervisor();
    await sup.start();
    await flushMicrotasks();
    expect(spawnedChildren).toHaveLength(0);
    const status = sup.getStatus();
    expect(status.state).toBe("failed");
    if (status.state === "failed") {
      expect(status.reason).toMatch(/next.*binary/i);
    }
  });

  it("emits 'status' events for each transition", async () => {
    const sup = await newSupervisor();
    const events: string[] = [];
    sup.on("status", (s: { state: string }) => events.push(s.state));
    await sup.start();
    await flushMicrotasks();
    expect(events).toContain("starting");
    expect(events).toContain("running");
    await sup.stop();
  });
});

describe("WebSupervisor — child exit + backoff", () => {
  it("schedules a restart on unexpected exit (exponential backoff)", async () => {
    vi.useFakeTimers();
    const sup = await newSupervisor({ baseBackoffMs: 100, maxBackoffMs: 800 });
    await sup.start();
    await flushMicrotasks();

    // Simulate the child crashing.
    spawnedChildren[0]!.emit("exit", 1, null);
    await flushMicrotasks();

    const after = sup.getStatus();
    expect(after.state).toBe("backoff");
    if (after.state === "backoff") {
      expect(after.restarts).toBe(1);
    }

    // Advance to fire the restart timer (100ms for attempt #1).
    vi.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(spawnedChildren.length).toBe(2);
    await sup.stop();
  });

  it("caps backoff at maxBackoffMs", async () => {
    vi.useFakeTimers();
    const sup = await newSupervisor({ baseBackoffMs: 100, maxBackoffMs: 250 });
    await sup.start();
    await flushMicrotasks();

    // Crash 5 times — 100, 200, 400(capped to 250), 250, 250
    const expectedDelays = [100, 200, 250, 250, 250];
    for (let i = 0; i < expectedDelays.length; i++) {
      spawnedChildren[i]!.emit("exit", 1, null);
      await flushMicrotasks();
      vi.advanceTimersByTime(expectedDelays[i]!);
      await flushMicrotasks();
    }
    // Initial + 5 restart spawns
    expect(spawnedChildren.length).toBe(6);
    await sup.stop();
  });

  it("respects maxRestarts and gives up with state=failed", async () => {
    vi.useFakeTimers();
    const sup = await newSupervisor({ baseBackoffMs: 50, maxRestarts: 2 });
    await sup.start();
    await flushMicrotasks();

    // Three crashes in a row; maxRestarts=2 so the third should fail.
    for (let i = 0; i < 3; i++) {
      spawnedChildren[i]?.emit("exit", 1, null);
      await flushMicrotasks();
      vi.advanceTimersByTime(50 * Math.pow(2, i));
      await flushMicrotasks();
    }
    const status = sup.getStatus();
    expect(status.state).toBe("failed");
    if (status.state === "failed") {
      expect(status.reason).toMatch(/max restarts/i);
    }
  });
});

describe("WebSupervisor — stop()", () => {
  it("kills the child and clears the restart timer", async () => {
    vi.useFakeTimers();
    const sup = await newSupervisor();
    await sup.start();
    await flushMicrotasks();
    const child = spawnedChildren[0]!;

    await sup.stop();
    expect(child.kill).toHaveBeenCalled();
    expect(sup.getStatus()).toEqual({ state: "stopped" });

    // After stop, scheduled timers should not respawn.
    vi.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(spawnedChildren.length).toBe(1);
  });

  it("is a safe no-op when never started", async () => {
    const sup = await newSupervisor();
    await sup.stop();
    expect(sup.getStatus()).toEqual({ state: "stopped" });
  });
});

describe("WebSupervisor — restart()", () => {
  it("stops the current child and starts a new one", async () => {
    const sup = await newSupervisor();
    await sup.start();
    await flushMicrotasks();
    await sup.restart();
    await flushMicrotasks();
    expect(spawnedChildren.length).toBe(2);
    await sup.stop();
  });

  it("does nothing when not currently running", async () => {
    const sup = await newSupervisor();
    await sup.restart();
    await flushMicrotasks();
    expect(spawnedChildren.length).toBe(0);
  });
});
