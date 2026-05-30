import cors from "cors";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "./routes.js";

// Minimal stub matching the surface registerApiRoutes touches on PiSessionManager.
function makePiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listActiveSessions: vi.fn(() => [
      {
        id: "default",
        sessionId: "x",
        thinkingLevel: "off",
        isStreaming: false,
        messageCount: 0,
        sessionFile: undefined,
        model: undefined,
      },
    ]),
    listPersistedSessions: vi.fn(async () => [{ id: "s1", path: "/tmp/s1.jsonl", name: "session 1", modifiedAt: 1 }]),
    newSession: vi.fn(async () => undefined),
    disposeSession: vi.fn(),
    getAvailableModels: vi.fn(async () => [
      { id: "m1", name: "Model 1", provider: "anthropic", contextWindow: 200_000, reasoning: false },
    ]),
    ...overrides,
  } as unknown as Parameters<typeof registerApiRoutes>[1];
}

function makeApp(pi = makePiStub()) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  registerApiRoutes(app, pi);
  return { app, pi };
}

describe("GET /api/sessions/active", () => {
  it("returns the active session list from the manager", async () => {
    const { app, pi } = makeApp();
    const res = await request(app).get("/api/sessions/active");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe("default");
    expect(pi.listActiveSessions).toHaveBeenCalledOnce();
  });
});

describe("GET /api/sessions", () => {
  it("returns persisted sessions", async () => {
    const { app, pi } = makeApp();
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].path).toBe("/tmp/s1.jsonl");
    expect(pi.listPersistedSessions).toHaveBeenCalledOnce();
  });

  it("returns 500 with an error message on failure", async () => {
    const pi = makePiStub({
      listPersistedSessions: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const { app } = makeApp(pi);
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/disk full/);
  });
});

describe("POST /api/sessions", () => {
  it("creates a new session, generating an id when none is provided", async () => {
    const { app, pi } = makeApp();
    const res = await request(app).post("/api/sessions").send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.sessionId).toBe("string");
    expect((pi.newSession as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(res.body.sessionId);
  });

  it("uses the provided sessionId verbatim", async () => {
    const { app, pi } = makeApp();
    const res = await request(app).post("/api/sessions").send({ sessionId: "custom" });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe("custom");
    expect(pi.newSession).toHaveBeenCalledWith("custom");
  });

  it("reports manager failures as 500", async () => {
    const pi = makePiStub({
      newSession: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const { app } = makeApp(pi);
    const res = await request(app).post("/api/sessions").send({});
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/nope/);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("disposes the session and returns success", async () => {
    const { app, pi } = makeApp();
    const res = await request(app).delete("/api/sessions/abc");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(pi.disposeSession).toHaveBeenCalledWith("abc");
  });
});

describe("GET /api/models", () => {
  it("returns the available model list from the manager", async () => {
    const { app, pi } = makeApp();
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("m1");
    expect(pi.getAvailableModels).toHaveBeenCalledOnce();
  });

  it("returns 500 on manager failure", async () => {
    const pi = makePiStub({
      getAvailableModels: vi.fn(async () => {
        throw new Error("auth missing");
      }),
    });
    const { app } = makeApp(pi);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/auth missing/);
  });
});
