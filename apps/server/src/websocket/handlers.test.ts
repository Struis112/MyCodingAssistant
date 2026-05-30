// WebSocket handler unit tests.
// The handlers attach via `io.on("connection", ...)` so we drive them by:
//   1. Building stub `io` and `socket` event emitters that match socket.io's
//      surface enough for the handler.
//   2. Calling registerWebSocketHandlers(io, piManager).
//   3. Capturing the connection-listener and invoking it with our stub socket.
//   4. Firing events on the socket and asserting which io/socket emits fire.

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebSocketHandlers } from "./handlers.js";

interface EmitSpyEE extends EventEmitter {
  emit: EventEmitter["emit"];
  emitSpy: ReturnType<typeof vi.fn>;
}

function makeEE(id?: string): EmitSpyEE & { id?: string } {
  const ee = new EventEmitter() as EmitSpyEE & { id?: string };
  ee.id = id;
  const origEmit = ee.emit.bind(ee);
  const spy = vi.fn(origEmit);
  ee.emit = spy as unknown as typeof ee.emit;
  ee.emitSpy = spy;
  return ee;
}

function makeSessionStub(overrides: Partial<Record<string, unknown>> = {}) {
  let isStreaming = false;
  return {
    get isStreaming() {
      return isStreaming;
    },
    setStreaming(v: boolean) {
      isStreaming = v;
    },
    sessionFile: "/tmp/session.jsonl",
    sessionId: "pi-session-1",
    model: { id: "m1", name: "Model 1", provider: "anthropic" },
    thinkingLevel: "off",
    messages: [],
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    setModel: vi.fn(),
    ...overrides,
  };
}

function makePiStub(session = makeSessionStub()) {
  return {
    getSession: vi.fn(() => session),
    getOrCreateSession: vi.fn(async () => session),
    setSessionModel: vi.fn(async (_: string, p: string, id: string) => ({
      id,
      name: "Model",
      provider: p,
    })),
    setSessionThinkingLevel: vi.fn(),
    newSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listPersistedSessions: vi.fn(async () => [
      { id: "s1", path: "/tmp/s1.jsonl", name: "Session", modifiedAt: 1 },
    ]),
    session,
  };
}

function setup(piOverride?: ReturnType<typeof makePiStub>) {
  const io = makeEE();
  const socket = makeEE("sock-1");
  const pi = piOverride ?? makePiStub();

  registerWebSocketHandlers(
    io as unknown as Parameters<typeof registerWebSocketHandlers>[0],
    pi as unknown as Parameters<typeof registerWebSocketHandlers>[1],
  );

  // io.on("connection", listener) — fire it with our stub socket.
  io.emit("connection", socket);

  return { io, socket, pi };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("chat:send (idle)", () => {
  it("calls session.prompt and broadcasts chat:done via io", async () => {
    const { io, socket, pi } = setup();
    socket.emit("chat:send", { sessionId: "default", message: "hi" });
    await new Promise((r) => setImmediate(r));

    expect(pi.session.prompt).toHaveBeenCalledWith("hi", undefined);
    const ioEmits = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(ioEmits).toContain("chat:done");
  });

  it("forwards image attachments to session.prompt as ImageContent", async () => {
    const { socket, pi } = setup();
    socket.emit("chat:send", {
      sessionId: "default",
      message: "describe",
      images: [{ data: "ABC", mediaType: "image/png" }],
    });
    await new Promise((r) => setImmediate(r));

    const [text, opts] = (pi.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(text).toBe("describe");
    expect(opts).toBeDefined();
    expect(opts.images).toHaveLength(1);
    expect(opts.images[0]).toMatchObject({
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: "ABC" },
    });
  });

  it("emits chat:done even when session.prompt throws", async () => {
    const session = makeSessionStub({
      prompt: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const pi = makePiStub(session);
    const { io } = setup(pi);
    pi.session = session;
    // Re-trigger setup since we changed pi after — easier to re-run:
    const { io: io2, socket } = setup(pi);
    socket.emit("chat:send", { sessionId: "default", message: "x" });
    await new Promise((r) => setImmediate(r));

    const events = io2.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:error");
    expect(events).toContain("chat:done");
    // suppress unused warning
    void io;
  });
});

describe("chat:send (already streaming)", () => {
  it("steers by default and emits chat:queued", async () => {
    const session = makeSessionStub();
    session.setStreaming(true);
    const pi = makePiStub(session);
    const { io, socket } = setup(pi);

    socket.emit("chat:send", { sessionId: "default", message: "redirect" });
    await new Promise((r) => setImmediate(r));

    expect(session.steer).toHaveBeenCalledWith("redirect");
    expect(session.prompt).not.toHaveBeenCalled();
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:queued");
  });

  it("uses session.followUp when behavior=followUp", async () => {
    const session = makeSessionStub();
    session.setStreaming(true);
    const pi = makePiStub(session);
    const { socket } = setup(pi);

    socket.emit("chat:send", { sessionId: "default", message: "after", behavior: "followUp" });
    await new Promise((r) => setImmediate(r));

    expect(session.followUp).toHaveBeenCalledWith("after");
    expect(session.steer).not.toHaveBeenCalled();
  });
});

describe("chat:abort", () => {
  it("calls session.abort and broadcasts chat:aborted + chat:done", async () => {
    const { io, socket, pi } = setup();
    socket.emit("chat:abort", { sessionId: "default" });
    await new Promise((r) => setImmediate(r));

    expect(pi.session.abort).toHaveBeenCalled();
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:aborted");
    expect(events).toContain("chat:done");
  });

  it("still emits chat:done when no session exists", async () => {
    const pi = makePiStub();
    pi.getSession = vi.fn(() => undefined) as unknown as typeof pi.getSession;
    const { io, socket } = setup(pi);
    socket.emit("chat:abort", { sessionId: "default" });
    await new Promise((r) => setImmediate(r));
    expect(io.emitSpy.mock.calls.map((c) => c[0])).toContain("chat:done");
  });
});

describe("chat:list", () => {
  it("returns the persisted-session list to the socket", async () => {
    const { socket, pi } = setup();
    socket.emit("chat:list");
    await new Promise((r) => setImmediate(r));

    expect(pi.listPersistedSessions).toHaveBeenCalledOnce();
    const events = socket.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:sessions");
  });
});

describe("chat:state", () => {
  it("returns a snapshot of the current session", async () => {
    const { socket } = setup();
    socket.emit("chat:state", { sessionId: "default" });
    await new Promise((r) => setImmediate(r));

    const stateEmit = socket.emitSpy.mock.calls.find((c) => c[0] === "chat:state:result");
    expect(stateEmit).toBeDefined();
    const payload = stateEmit![1] as { state: { thinkingLevel: string } | null };
    expect(payload.state?.thinkingLevel).toBe("off");
  });

  it("returns state=null when no session is registered", async () => {
    const pi = makePiStub();
    pi.getSession = vi.fn(() => undefined) as unknown as typeof pi.getSession;
    const { socket } = setup(pi);
    socket.emit("chat:state", { sessionId: "missing" });
    await new Promise((r) => setImmediate(r));

    const stateEmit = socket.emitSpy.mock.calls.find((c) => c[0] === "chat:state:result");
    expect((stateEmit![1] as { state: unknown }).state).toBeNull();
  });
});

describe("session:setModel", () => {
  it("calls PiSessionManager.setSessionModel and broadcasts session:modelChanged", async () => {
    const { io, socket, pi } = setup();
    socket.emit("session:setModel", { sessionId: "default", provider: "anthropic", modelId: "m1" });
    await new Promise((r) => setImmediate(r));

    expect(pi.setSessionModel).toHaveBeenCalledWith("default", "anthropic", "m1");
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("session:modelChanged");
  });
});

describe("session:setThinkingLevel", () => {
  it("calls PiSessionManager.setSessionThinkingLevel and broadcasts the change", async () => {
    const { io, socket, pi } = setup();
    socket.emit("session:setThinkingLevel", { sessionId: "default", level: "high" });
    await new Promise((r) => setImmediate(r));

    expect(pi.setSessionThinkingLevel).toHaveBeenCalledWith("default", "high");
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("session:thinkingLevelChanged");
  });
});

describe("chat:new", () => {
  it("creates a new session and broadcasts chat:new", async () => {
    const { io, socket, pi } = setup();
    socket.emit("chat:new", { sessionId: "default" });
    await new Promise((r) => setImmediate(r));

    expect(pi.newSession).toHaveBeenCalledWith("default");
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:new");
  });
});

describe("chat:resume", () => {
  it("resumes a session by file path and broadcasts chat:resumed", async () => {
    const { io, socket, pi } = setup();
    socket.emit("chat:resume", { sessionId: "default", sessionFile: "/tmp/x.jsonl" });
    await new Promise((r) => setImmediate(r));

    expect(pi.resumeSession).toHaveBeenCalledWith("default", "/tmp/x.jsonl");
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("chat:resumed");
  });
});
