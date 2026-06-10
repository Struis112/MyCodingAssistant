import { describe, expect, it, vi } from "vitest";
import { RepairSessionService, type RepairSessionOptions } from "./repair-session.js";
import type { AgentLike, ConnectorManager } from "../connectors/types.js";

function fakeAgent(): AgentLike {
  // Only the surface RepairSessionService touches is mocked.
  const agent = {
    isStreaming: false,
    messages: [],
    sessionFile: undefined,
    sessionId: "__deploy_repair__",
    sessionName: "Self-healing deploy",
    model: null,
    thinkingLevel: "medium",
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    dispose: vi.fn(),
  };
  return agent as unknown as AgentLike;
}

function fakeManager(agent: AgentLike): ConnectorManager {
  // Mirror the real manager's lifecycle: getSession returns undefined until
  // getOrCreateSession has been called at least once, then returns the agent.
  // This is what ensureSession() depends on to know it needs to prime the model.
  let created = false;
  return {
    getSession: vi.fn(() => (created ? agent : undefined)),
    getOrCreateSession: vi.fn(async () => {
      created = true;
      return agent;
    }),
    setSessionModel: vi.fn(async () => ({ id: "fake", provider: "anthropic" })),
    setSessionThinkingLevel: vi.fn(),
    setSessionName: vi.fn(),
    listActiveSessions: vi.fn(() => []),
    listPersistedSessions: vi.fn(async () => []),
    deletePersistedSession: vi.fn(async () => undefined),
    resumeSession: vi.fn(async () => agent),
    newSession: vi.fn(async () => agent),
    getAvailableModels: vi.fn(async () => []),
    disposeSession: vi.fn(),
    disposeAll: vi.fn(),
  } as unknown as ConnectorManager;
}

function makeService(
  manager: ConnectorManager,
  overrides: Partial<RepairSessionOptions> = {},
): RepairSessionService {
  return new RepairSessionService({
    manager,
    repoDir: "/repo",
    pollIntervalMs: 10,
    revParse: async () => "before",
    sleep: () => Promise.resolve(),
    now: () => 0,
    ...overrides,
  });
}

describe("RepairSessionService.requestRepair", () => {
  it("resolves with the new SHA when staging advances", async () => {
    const agent = fakeAgent();
    const manager = fakeManager(agent);
    let calls = 0;
    const revParse = vi.fn(async () => {
      calls++;
      return calls === 1 ? "before" : "after";
    });
    // agent.isStreaming stays false — we want prompt() (not followUp), and the
    // SHA changes on the first poll so gave_up never has a chance to trigger.
    const svc = makeService(manager, { revParse });
    const r = await svc.requestRepair({
      attempt: 1,
      failedPhase: "validating",
      logs: "TS2307: missing module",
      elapsedMs: 5_000,
      remainingMs: 60_000,
    });

    expect(r).toEqual({ newSha: "after", reason: "committed" });
    expect(agent.prompt).toHaveBeenCalledOnce();
    // The message includes the failure context.
    const msg = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("Failed phase: validating");
    expect(msg).toContain("TS2307");
  });

  it("returns gave_up when the agent settles without a commit (past grace window)", async () => {
    const agent = fakeAgent(); // not streaming
    const manager = fakeManager(agent);
    let t = 0;
    const svc = makeService(manager, {
      revParse: async () => "before", // never changes
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollIntervalMs: 1_000, // each poll advances 1s
    });

    const r = await svc.requestRepair({
      attempt: 2,
      failedPhase: "validating",
      logs: "",
      elapsedMs: 0,
      remainingMs: 60_000,
    });
    // Grace = 5s; after the 6th poll we're past it AND agent.isStreaming=false.
    expect(r).toEqual({ newSha: null, reason: "gave_up" });
  });

  it("returns timed_out when remainingMs elapses with no commit and agent still streaming", async () => {
    const agent = fakeAgent();
    Object.defineProperty(agent, "isStreaming", { value: true, configurable: true });
    const manager = fakeManager(agent);
    let t = 0;
    const svc = makeService(manager, {
      revParse: async () => "before",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollIntervalMs: 1_000,
    });

    const r = await svc.requestRepair({
      attempt: 3,
      failedPhase: "verifying",
      logs: "",
      elapsedMs: 0,
      remainingMs: 3_000, // 3s budget
    });
    expect(r).toEqual({ newSha: null, reason: "timed_out" });
  });

  it("uses followUp when the agent is already streaming a previous turn", async () => {
    const agent = fakeAgent();
    Object.defineProperty(agent, "isStreaming", { value: true, configurable: true });
    const manager = fakeManager(agent);
    let calls = 0;
    const revParse = vi.fn(async () => {
      calls++;
      return calls === 1 ? "before" : "after";
    });
    const svc = makeService(manager, { revParse });

    await svc.requestRepair({
      attempt: 4,
      failedPhase: "building",
      logs: "",
      elapsedMs: 0,
      remainingMs: 60_000,
    });
    expect(agent.followUp).toHaveBeenCalledOnce();
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("locks in the configured model on the first request only", async () => {
    const agent = fakeAgent();
    const manager = fakeManager(agent);
    Object.defineProperty(agent, "isStreaming", { value: true, configurable: true });
    let calls = 0;
    const revParse = async () => (++calls === 1 ? "before" : "after");
    const svc = makeService(manager, {
      revParse,
      model: "anthropic/claude-sonnet-4-5",
    });
    // First request primes the model.
    await svc.requestRepair({
      attempt: 1,
      failedPhase: "validating",
      logs: "",
      elapsedMs: 0,
      remainingMs: 60_000,
    });
    expect(manager.setSessionModel).toHaveBeenCalledWith(
      "__deploy_repair__",
      "anthropic",
      "claude-sonnet-4-5",
    );
    // Second request reuses the existing session — model setter is NOT called again.
    calls = 0;
    await svc.requestRepair({
      attempt: 2,
      failedPhase: "validating",
      logs: "",
      elapsedMs: 0,
      remainingMs: 60_000,
    });
    expect((manager.setSessionModel as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("RepairSessionService.recordPark", () => {
  it("invokes the onPark callback and posts a system follow-up", async () => {
    const agent = fakeAgent();
    const manager = fakeManager(agent);
    const onPark = vi.fn();
    const svc = makeService(manager, { onPark });
    svc.recordPark({ reason: "budget_exhausted", attempts: 5, liveSha: "abcdef1234" });
    expect(onPark).toHaveBeenCalledWith({
      reason: "budget_exhausted",
      attempts: 5,
      liveSha: "abcdef1234",
    });
    // followUp lands asynchronously — wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.followUp).toHaveBeenCalled();
    const msg = (agent.followUp as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("parked after 5 attempt");
    expect(msg).toContain("abcdef12");
  });
});
