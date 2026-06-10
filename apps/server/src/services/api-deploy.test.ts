import { describe, expect, it, vi } from "vitest";
import {
  createApiActivatable,
  createApiDeployPipeline,
  createApiProbes,
  type ApiDeployDeps,
} from "./api-deploy.js";

function makeDeps(overrides: Partial<ApiDeployDeps> = {}): ApiDeployDeps {
  return {
    repoDir: "C:/repo",
    serviceName: "MyCodingAssistant",
    nssmPath: "C:/repo/tools/nssm/nssm.exe",
    apiPort: 7641,
    run: vi.fn(async () => ({ ok: true, logs: "" })),
    portListening: vi.fn(async () => true),
    httpStatus: vi.fn(async () => 200),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

describe("createApiProbes", () => {
  it("build runs `npm run build --workspace=@mca/server` and throws on failure", async () => {
    const run = vi.fn(async () => ({ ok: false, logs: "TS2307: missing module" }));
    const deps = makeDeps({ run });
    const probes = createApiProbes(deps);
    await expect(probes.build!()).rejects.toThrow(/TS2307/);
    expect(run).toHaveBeenCalledWith("npm", ["run", "build", "--workspace=@mca/server"], "C:/repo");
  });

  it("readiness probes the API port", async () => {
    const portListening = vi.fn(async () => true);
    const probes = createApiProbes(makeDeps({ portListening }));
    expect(await probes.readiness!()).toBe(true);
    expect(portListening).toHaveBeenCalledWith(7641);
  });

  it("smoke considers any status < 500 healthy", async () => {
    const probes200 = createApiProbes(makeDeps({ httpStatus: async () => 200 }));
    const probes503 = createApiProbes(makeDeps({ httpStatus: async () => 503 }));
    const probesNull = createApiProbes(makeDeps({ httpStatus: async () => null }));
    expect((await probes200.smoke!()).ok).toBe(true);
    expect((await probes503.smoke!()).ok).toBe(false);
    expect((await probesNull.smoke!()).ok).toBe(false);
  });
});

describe("createApiActivatable", () => {
  it("invokes nssm restart <serviceName>", async () => {
    const run = vi.fn(async () => ({ ok: true, logs: "" }));
    const act = createApiActivatable(makeDeps({ run }));
    await act.restart();
    expect(run).toHaveBeenCalledWith(
      "C:/repo/tools/nssm/nssm.exe",
      ["restart", "MyCodingAssistant"],
      "C:/repo",
    );
  });

  it("throws when nssm restart fails so the controller rolls back", async () => {
    const run = vi.fn(async () => ({ ok: false, logs: "service not found" }));
    const act = createApiActivatable(makeDeps({ run }));
    await expect(act.restart()).rejects.toThrow(/nssm restart MyCodingAssistant failed/);
  });
});

describe("createApiDeployPipeline", () => {
  it("verifies a healthy candidate end-to-end", async () => {
    const pipeline = createApiDeployPipeline(
      makeDeps({
        stabilityWindowMs: 6,
        probeIntervalMs: 2,
        portListening: async () => true,
        httpStatus: async () => 200,
      }),
    );
    expect((await pipeline.activate()).ok).toBe(true);
    expect((await pipeline.verify()).ok).toBe(true);
  });

  it("fails verify when readiness drops mid-window", async () => {
    let calls = 0;
    const pipeline = createApiDeployPipeline(
      makeDeps({
        stabilityWindowMs: 6,
        probeIntervalMs: 2,
        portListening: async () => ++calls < 2,
        httpStatus: async () => 200,
      }),
    );
    const r = await pipeline.verify();
    expect(r.ok).toBe(false);
    expect(r.logs).toMatch(/readiness/);
  });

  it("fails verify when the smoke probe returns 5xx", async () => {
    const pipeline = createApiDeployPipeline(
      makeDeps({
        stabilityWindowMs: 6,
        probeIntervalMs: 2,
        portListening: async () => true,
        httpStatus: async () => 502,
      }),
    );
    const r = await pipeline.verify();
    expect(r.ok).toBe(false);
    expect(r.logs).toContain("502");
  });
});
