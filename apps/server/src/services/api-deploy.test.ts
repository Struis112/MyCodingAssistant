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
    appName: "mca-server",
    pm2Bin: "C:/repo/node_modules/pm2/bin/pm2",
    nodeBin: "node",
    apiPort: 7641,
    run: vi.fn(async () => ({ ok: true, logs: "" })),
    portListening: vi.fn(async () => true),
    httpStatus: vi.fn(async () => 200),
    sleep: () => Promise.resolve(),
    // Tiny readiness timeout for tests so a failure case resolves in ms.
    readyTimeoutMs: 100,
    readyProbeIntervalMs: 10,
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
  it("invokes `pm2 restart <appName>` via node + the pm2 bin", async () => {
    const run = vi.fn(async () => ({ ok: true, logs: "" }));
    const act = createApiActivatable(makeDeps({ run }));
    await act.restart();
    // Exactly one activation call: node <pm2Bin> restart mca-server, in repoDir.
    expect(run).toHaveBeenCalledWith(
      "node",
      ["C:/repo/node_modules/pm2/bin/pm2", "restart", "mca-server"],
      "C:/repo",
    );
  });

  it("does NOT pass --update-env (PM2 must keep the app's ecosystem env)", async () => {
    const run = vi.fn(async () => ({ ok: true, logs: "" }));
    const act = createApiActivatable(makeDeps({ run }));
    await act.restart();
    const args = (run.mock.calls[0] as unknown as [string, string[], string])[1];
    expect(args).not.toContain("--update-env");
  });

  it("throws when `pm2 restart` fails (app unknown / daemon down)", async () => {
    const run = vi.fn(async () => ({
      ok: false,
      logs: "[PM2][ERROR] Process or Namespace mca-server not found",
    }));
    const act = createApiActivatable(makeDeps({ run }));
    await expect(act.restart()).rejects.toThrow(/pm2 restart mca-server failed/);
  });

  it("waits for /healthz=200 after restart before returning", async () => {
    let calls = 0;
    const httpStatus = vi.fn(async () => {
      // First two probes: API still booting (no response). Third: 200.
      calls++;
      if (calls < 3) return null;
      return 200;
    });
    const act = createApiActivatable(makeDeps({ httpStatus, readyTimeoutMs: 200 }));
    await expect(act.restart()).resolves.toBeUndefined();
    expect(httpStatus).toHaveBeenCalledWith(7641, "/healthz");
    // At least 3 calls (2 not-ready + 1 ready) — serializes activate properly.
    expect((httpStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("throws if /healthz never returns 200 within readyTimeoutMs", async () => {
    const httpStatus = vi.fn(async () => null);
    const act = createApiActivatable(makeDeps({ httpStatus, readyTimeoutMs: 50 }));
    await expect(act.restart()).rejects.toThrow(/API did not become ready/);
  });

  it("throws on a persistent 5xx from /healthz (boot failure)", async () => {
    const httpStatus = vi.fn(async () => 500);
    const act = createApiActivatable(
      makeDeps({ httpStatus, readyTimeoutMs: 30, readyProbeIntervalMs: 5 }),
    );
    await expect(act.restart()).rejects.toThrow(/last \/healthz status: 500/);
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
