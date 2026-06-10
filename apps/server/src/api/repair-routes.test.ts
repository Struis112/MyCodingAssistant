import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerRepairRoutes } from "./repair-routes.js";
import type { RepairSessionService } from "../services/repair-session.js";

function mountApp(svc: Partial<RepairSessionService>, token: string) {
  const app = express();
  app.use(express.json());
  registerRepairRoutes(app, {
    service: svc as RepairSessionService,
    token,
  });
  return app;
}

const VALID_TOKEN = "a".repeat(64);

describe("POST /api/repair/prompt", () => {
  it("rejects without the token (401)", async () => {
    const app = mountApp({ requestRepair: vi.fn() }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/prompt")
      .send({ attempt: 1, failedPhase: "validating", logs: "", elapsedMs: 0, remainingMs: 1000 });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token (401, constant-time)", async () => {
    const app = mountApp({ requestRepair: vi.fn() }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/prompt")
      .set("X-MCA-Deploy-Token", "b".repeat(64))
      .send({ attempt: 1, failedPhase: "validating", logs: "", elapsedMs: 0, remainingMs: 1000 });
    expect(res.status).toBe(401);
  });

  it("400s on a malformed body", async () => {
    const app = mountApp({ requestRepair: vi.fn() }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/prompt")
      .set("X-MCA-Deploy-Token", VALID_TOKEN)
      .send({ attempt: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("forwards a valid body to the service and returns the resolution", async () => {
    const requestRepair = vi.fn().mockResolvedValue({ newSha: "abc123", reason: "committed" });
    const app = mountApp({ requestRepair }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/prompt")
      .set("X-MCA-Deploy-Token", VALID_TOKEN)
      .send({ attempt: 2, failedPhase: "verifying", logs: "x", elapsedMs: 5, remainingMs: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ newSha: "abc123", reason: "committed" });
    expect(requestRepair).toHaveBeenCalledWith({
      attempt: 2,
      failedPhase: "verifying",
      logs: "x",
      elapsedMs: 5,
      remainingMs: 9,
    });
  });

  it("returns 500 when the service throws", async () => {
    const requestRepair = vi.fn().mockRejectedValue(new Error("boom"));
    const app = mountApp({ requestRepair }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/prompt")
      .set("X-MCA-Deploy-Token", VALID_TOKEN)
      .send({ attempt: 1, failedPhase: "validating", logs: "", elapsedMs: 0, remainingMs: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("boom");
  });
});

describe("POST /api/repair/parked", () => {
  it("calls recordPark and returns ok", async () => {
    const recordPark = vi.fn();
    const app = mountApp({ recordPark }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/parked")
      .set("X-MCA-Deploy-Token", VALID_TOKEN)
      .send({ reason: "budget_exhausted", attempts: 4, liveSha: "deadbeef" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordPark).toHaveBeenCalledWith({
      reason: "budget_exhausted",
      attempts: 4,
      summary: undefined,
      liveSha: "deadbeef",
    });
  });

  it("400s on a malformed body", async () => {
    const app = mountApp({ recordPark: vi.fn() }, VALID_TOKEN);
    const res = await request(app)
      .post("/api/repair/parked")
      .set("X-MCA-Deploy-Token", VALID_TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("token guard with empty token", () => {
  it("permits requests through when the configured token is empty (dev/test)", async () => {
    const recordPark = vi.fn();
    const app = mountApp({ recordPark }, "");
    const res = await request(app).post("/api/repair/parked").send({ reason: "x", attempts: 1 });
    expect(res.status).toBe(200);
    expect(recordPark).toHaveBeenCalled();
  });
});
