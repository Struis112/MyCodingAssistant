import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    listPersistedSessions: vi.fn(async () => [
      { id: "s1", path: "/tmp/s1.jsonl", name: "session 1", modifiedAt: 1 },
    ]),
    newSession: vi.fn(async () => undefined),
    disposeSession: vi.fn(),
    getAvailableModels: vi.fn(async () => [
      {
        id: "m1",
        name: "Model 1",
        provider: "anthropic",
        contextWindow: 200_000,
        reasoning: false,
      },
    ]),
    ...overrides,
  } as unknown as Parameters<typeof registerApiRoutes>[1];
}

function makeApp(pi = makePiStub(), cwd?: string) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  registerApiRoutes(app, pi, cwd ? { cwd } : {});
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

// ----- File routes (revert / list / read / save) -----

const NEW = "line1\nline2\nline3X\nline4\nline5\n";
const OLD = "line1\nline2\nline3\nline4\nline5\n";
const PATCH = [
  "@@ -1,5 +1,5 @@",
  " line1",
  " line2",
  "-line3",
  "+line3X",
  " line4",
  " line5",
  "",
].join("\n");

const tmpDirs: string[] = [];
afterEach(() => {
  tmpDirs.length = 0; // OS reclaims tmp; no need to rm in tests
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mca-routes-"));
  tmpDirs.push(root);
  await Promise.all(
    Object.entries(files).map(([rel, content]) => writeFile(path.join(root, rel), content)),
  );
  return root;
}

describe("POST /api/files/revert", () => {
  it("reverse-applies the patch, restoring the original file", async () => {
    const root = await makeProject({ "f.txt": NEW });
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).post("/api/files/revert").send({ path: "f.txt", patch: PATCH });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await readFile(path.join(root, "f.txt"), "utf-8")).toBe(OLD);
  });

  it("rejects missing fields with 400", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/api/files/revert").send({ path: "f.txt" });
    expect(res.status).toBe(400);
  });

  it("refuses paths outside the project root with 403", async () => {
    const root = await makeProject({});
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app)
      .post("/api/files/revert")
      .send({ path: "../escape.txt", patch: PATCH });
    expect(res.status).toBe(403);
  });

  it("returns 409 when the file no longer matches the patch", async () => {
    const root = await makeProject({ "f.txt": "totally different\n" });
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).post("/api/files/revert").send({ path: "f.txt", patch: PATCH });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /api/files/list", () => {
  it("lists immediate children, dirs first, ignoring node_modules", async () => {
    const root = await makeProject({ "b.txt": "", "a.txt": "" });
    await writeFile(path.join(root, "node_modules"), ""); // a file named like an ignored dir is kept
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).get("/api/files/list");
    expect(res.status).toBe(200);
    const names = (res.body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("refuses to list outside the project root", async () => {
    const root = await makeProject({});
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).get("/api/files/list").query({ dir: "../.." });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/files/read & POST /api/files/save", () => {
  it("reads a file's contents", async () => {
    const root = await makeProject({ "f.txt": "hello\n" });
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).get("/api/files/read").query({ path: "f.txt" });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("hello\n");
  });

  it("404s a missing file", async () => {
    const root = await makeProject({});
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).get("/api/files/read").query({ path: "nope.txt" });
    expect(res.status).toBe(404);
  });

  it("overwrites an existing file", async () => {
    const root = await makeProject({ "f.txt": "old" });
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).post("/api/files/save").send({ path: "f.txt", content: "new" });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(root, "f.txt"), "utf-8")).toBe("new");
  });

  it("refuses to create a non-existent file via save (404)", async () => {
    const root = await makeProject({});
    const { app } = makeApp(makePiStub(), root);
    const res = await request(app).post("/api/files/save").send({ path: "new.txt", content: "x" });
    expect(res.status).toBe(404);
  });
});
