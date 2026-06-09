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

// io.to(room).emit(...) needs a tiny stand-in that funnels events back
// through the same `io.emitSpy` so existing assertions over event names
// keep working. We also track every (room, event) pair so room-routing
// itself can be asserted.
interface IoStub extends EmitSpyEE {
  toCalls: Array<{ room: string; event: string; payload: unknown }>;
  to: (room: string) => { emit: (event: string, payload?: unknown) => void };
}

function makeIo(): IoStub {
  const io = makeEE() as IoStub;
  io.toCalls = [];
  io.to = (room: string) => ({
    emit: (event: string, payload?: unknown) => {
      io.toCalls.push({ room, event, payload });
      // Also fire on the io spy so tests that only care about event names
      // (and not the room) keep passing.
      io.emit(event, payload);
    },
  });
  return io;
}

// socket.join(room) — track every room a socket is asked to subscribe to.
interface SocketStub extends EmitSpyEE {
  id?: string;
  joinedRooms: string[];
  join: (room: string) => void;
}

function makeSocket(id: string): SocketStub {
  const socket = makeEE(id) as SocketStub;
  socket.joinedRooms = [];
  socket.join = (room: string) => {
    socket.joinedRooms.push(room);
  };
  return socket;
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
    setSessionName: vi.fn((_: string, name: string) => name),
    newSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    listPersistedSessions: vi.fn(async () => [
      { id: "s1", path: "/tmp/s1.jsonl", name: "Session", modifiedAt: 1 },
    ]),
    deletePersistedSession: vi.fn(async () => {}),
    session,
  };
}

function setup(piOverride?: ReturnType<typeof makePiStub>) {
  const io = makeIo();
  const socket = makeSocket("sock-1");
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

  it("restores the session by sessionFile before prompting (continues after a restart)", async () => {
    const session = makeSessionStub();
    const pi = makePiStub(session);
    let inMemory = false; // simulate a fresh server: not in the in-memory map yet
    pi.getSession = vi.fn(() =>
      inMemory ? session : undefined,
    ) as unknown as typeof pi.getSession;
    pi.getOrCreateSession = vi.fn(async () => {
      inMemory = true;
      return session;
    }) as unknown as typeof pi.getOrCreateSession;

    const { socket } = setup(pi);
    socket.emit("chat:send", {
      sessionId: "default",
      message: "continue please",
      sessionFile: "/tmp/sessionA.jsonl",
    });
    await new Promise((r) => setImmediate(r));

    // Restored THIS conversation by file (not a fresh empty session)...
    expect(pi.getOrCreateSession).toHaveBeenCalledWith("default", {
      sessionFile: "/tmp/sessionA.jsonl",
    });
    // ...then prompted it, and told the client its canonical file to persist.
    expect(session.prompt).toHaveBeenCalledWith("continue please", undefined);
    expect(socket.emitSpy.mock.calls.some((c) => c[0] === "session:info")).toBe(true);
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
      data: "ABC",
      mimeType: "image/png",
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

describe("chat:delete", () => {
  it("deletes the file, confirms to the socket, and broadcasts a fresh list", async () => {
    const { io, socket, pi } = setup();
    socket.emit("chat:delete", { sessionFile: "/tmp/s1.jsonl" });
    await new Promise((r) => setImmediate(r));

    expect(pi.deletePersistedSession).toHaveBeenCalledWith("/tmp/s1.jsonl");
    expect(socket.emitSpy.mock.calls.map((c) => c[0])).toContain("chat:deleted");
    // The refreshed list is broadcast to everyone, not just the requester.
    expect(io.emitSpy.mock.calls.map((c) => c[0])).toContain("chat:sessions");
  });

  it("rejects an empty sessionFile without touching disk", async () => {
    const { socket, pi } = setup();
    socket.emit("chat:delete", { sessionFile: "  " });
    await new Promise((r) => setImmediate(r));

    expect(pi.deletePersistedSession).not.toHaveBeenCalled();
    expect(socket.emitSpy.mock.calls.map((c) => c[0])).toContain("chat:error");
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

  it("returns state=null when no session is registered and none are persisted", async () => {
    const pi = makePiStub();
    pi.getSession = vi.fn(() => undefined) as unknown as typeof pi.getSession;
    pi.listPersistedSessions = vi.fn(async () => []) as unknown as typeof pi.listPersistedSessions;
    const { socket } = setup(pi);
    socket.emit("chat:state", { sessionId: "missing" });
    await new Promise((r) => setImmediate(r));

    const stateEmit = socket.emitSpy.mock.calls.find((c) => c[0] === "chat:state:result");
    expect((stateEmit![1] as { state: unknown }).state).toBeNull();
    expect(pi.getOrCreateSession).not.toHaveBeenCalled();
  });

  it("restores the client's SPECIFIC session by sessionFile on reconnect (multi-session)", async () => {
    const session = makeSessionStub({
      messages: [{ role: "user", content: "session B message", timestamp: 1 }],
    });
    const pi = makePiStub(session);
    let inMemory = false;
    pi.getSession = vi.fn(() =>
      inMemory ? session : undefined,
    ) as unknown as typeof pi.getSession;
    pi.getOrCreateSession = vi.fn(async () => {
      inMemory = true;
      return session;
    }) as unknown as typeof pi.getOrCreateSession;

    const { socket } = setup(pi);
    socket.emit("chat:state", { sessionId: "tab-2", sessionFile: "/tmp/sessionB.jsonl" });
    await new Promise((r) => setImmediate(r));

    // Resumes the exact file — NOT continueRecent (which would hand every
    // client the same "most recent" conversation).
    expect(pi.getOrCreateSession).toHaveBeenCalledWith("tab-2", {
      sessionFile: "/tmp/sessionB.jsonl",
    });
    expect(pi.listPersistedSessions).not.toHaveBeenCalled();
    const stateEmit = socket.emitSpy.mock.calls.find((c) => c[0] === "chat:state:result");
    expect(
      (stateEmit![1] as { state: { messages: unknown[] } | null }).state?.messages,
    ).toHaveLength(1);
  });

  it("auto-restores the most recent persisted session on reconnect after a restart", async () => {
    // Simulate a fresh server process: the session isn't in memory yet, but a
    // persisted session exists on disk. The handler should reopen the most
    // recent one (continueRecent) and return its history.
    const session = makeSessionStub({
      messages: [{ role: "user", content: "earlier message", timestamp: 1 }],
    });
    const pi = makePiStub(session);
    let inMemory = false;
    pi.getSession = vi.fn(() =>
      inMemory ? session : undefined,
    ) as unknown as typeof pi.getSession;
    pi.getOrCreateSession = vi.fn(async () => {
      inMemory = true; // restored into the in-memory map
      return session;
    }) as unknown as typeof pi.getOrCreateSession;

    const { socket } = setup(pi);
    socket.emit("chat:state", { sessionId: "default" });
    await new Promise((r) => setImmediate(r));

    expect(pi.getOrCreateSession).toHaveBeenCalledWith("default", { continueRecent: true });
    const stateEmit = socket.emitSpy.mock.calls.find((c) => c[0] === "chat:state:result");
    const payload = stateEmit![1] as { state: { messages: unknown[] } | null };
    expect(payload.state).not.toBeNull();
    expect(payload.state!.messages).toHaveLength(1);
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

describe("session:setName", () => {
  it("renames the session and broadcasts session:nameChanged", async () => {
    const { io, socket, pi } = setup();
    socket.emit("session:setName", { sessionId: "default", name: "My feature work" });
    await new Promise((r) => setImmediate(r));

    expect(pi.setSessionName).toHaveBeenCalledWith("default", "My feature work");
    const events = io.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("session:nameChanged");
  });

  it("rejects an empty name with session:error and does not rename", async () => {
    const { socket, pi } = setup();
    socket.emit("session:setName", { sessionId: "default", name: "   " });
    await new Promise((r) => setImmediate(r));

    expect(pi.setSessionName).not.toHaveBeenCalled();
    const events = socket.emitSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("session:error");
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

describe("per-session rooms", () => {
  it("joins the session room on chat:send and routes chat:done there", async () => {
    const { io, socket } = setup();
    socket.emit("chat:send", { sessionId: "sess-abc", message: "hi" });
    await new Promise((r) => setImmediate(r));

    expect(socket.joinedRooms).toContain("session:sess-abc");
    const done = io.toCalls.find((c) => c.event === "chat:done");
    expect(done?.room).toBe("session:sess-abc");
  });

  it("routes chat:aborted + chat:done to the session room on chat:abort", async () => {
    const { io, socket } = setup();
    socket.emit("chat:abort", { sessionId: "sess-xyz" });
    await new Promise((r) => setImmediate(r));

    expect(socket.joinedRooms).toContain("session:sess-xyz");
    const rooms = io.toCalls
      .filter((c) => c.event === "chat:aborted" || c.event === "chat:done")
      .map((c) => c.room);
    expect(rooms.every((r) => r === "session:sess-xyz")).toBe(true);
    expect(rooms.length).toBeGreaterThanOrEqual(2);
  });

  it("joins on chat:state so a reloaded tab re-subscribes to its session", async () => {
    const { socket } = setup();
    socket.emit("chat:state", { sessionId: "sess-state" });
    await new Promise((r) => setImmediate(r));

    expect(socket.joinedRooms).toContain("session:sess-state");
  });

  it("routes session:modelChanged to the session room", async () => {
    const { io, socket } = setup();
    socket.emit("session:setModel", {
      sessionId: "sess-model",
      provider: "anthropic",
      modelId: "m1",
    });
    await new Promise((r) => setImmediate(r));

    const changed = io.toCalls.find((c) => c.event === "session:modelChanged");
    expect(changed?.room).toBe("session:sess-model");
  });

  it("routes session:thinkingLevelChanged to the session room", async () => {
    const { io, socket } = setup();
    socket.emit("session:setThinkingLevel", { sessionId: "sess-tl", level: "high" });
    await new Promise((r) => setImmediate(r));

    const changed = io.toCalls.find((c) => c.event === "session:thinkingLevelChanged");
    expect(changed?.room).toBe("session:sess-tl");
  });
});
