import { describe, expect, it, vi } from "vitest";
import { ServiceDeployPipeline } from "./service-deploy-pipeline.js";

const noopSleep = async () => {};

function makePipeline(over: {
  build?: () => Promise<void>;
  validate?: () => Promise<{ ok: boolean; logs?: string }>;
  readiness?: () => Promise<boolean>;
  smoke?: () => Promise<{ ok: boolean; logs?: string }>;
  restart?: () => Promise<void>;
  stabilityWindowMs?: number;
  probeIntervalMs?: number;
}) {
  const restart = over.restart ?? vi.fn(async () => {});
  const service = { restart };
  const pipeline = new ServiceDeployPipeline({
    service,
    probes: {
      build: over.build,
      validate: over.validate,
      readiness: over.readiness,
      smoke: over.smoke,
    },
    stabilityWindowMs: over.stabilityWindowMs ?? 10,
    probeIntervalMs: over.probeIntervalMs ?? 5, // → 2 readiness checks
    sleep: noopSleep,
  });
  return { pipeline, restart };
}

describe("ServiceDeployPipeline — build/validate/activate", () => {
  it("build: ok when hook resolves, fail with logs when it throws", async () => {
    const { pipeline } = makePipeline({ build: async () => {} });
    expect(await pipeline.build()).toEqual({ ok: true });

    const { pipeline: p2 } = makePipeline({
      build: async () => {
        throw new Error("tsc exploded");
      },
    });
    const r = await p2.build();
    expect(r.ok).toBe(false);
    expect(r.logs).toMatch(/tsc exploded/);
  });

  it("validate: passes through ok/logs and treats a throw as failure", async () => {
    const { pipeline } = makePipeline({ validate: async () => ({ ok: false, logs: "TS2304" }) });
    expect(await pipeline.validate()).toEqual({ ok: false, logs: "TS2304" });

    const { pipeline: p2 } = makePipeline({
      validate: async () => {
        throw new Error("boom");
      },
    });
    expect((await p2.validate()).ok).toBe(false);
  });

  it("activate: restarts the service", async () => {
    const { pipeline, restart } = makePipeline({});
    expect(await pipeline.activate()).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledOnce();
  });

  it("activate: reports failure when restart throws", async () => {
    const { pipeline } = makePipeline({
      restart: vi.fn(async () => {
        throw new Error("port in use");
      }),
    });
    const r = await pipeline.activate();
    expect(r.ok).toBe(false);
    expect(r.logs).toMatch(/port in use/);
  });
});

describe("ServiceDeployPipeline — verify (stability window + smoke)", () => {
  it("passes when readiness holds across the window and smoke passes", async () => {
    const readiness = vi.fn(async () => true);
    const smoke = vi.fn(async () => ({ ok: true }));
    const { pipeline } = makePipeline({ readiness, smoke });
    expect(await pipeline.verify()).toEqual({ ok: true });
    expect(readiness).toHaveBeenCalledTimes(2); // window 10 / interval 5
    expect(smoke).toHaveBeenCalledOnce();
  });

  it("fails if readiness drops during the stability window (no smoke run)", async () => {
    const readiness = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const smoke = vi.fn(async () => ({ ok: true }));
    const { pipeline } = makePipeline({ readiness, smoke });
    const r = await pipeline.verify();
    expect(r.ok).toBe(false);
    expect(r.logs).toMatch(/stability window/);
    expect(smoke).not.toHaveBeenCalled();
  });

  it("fails when the smoke test fails even if readiness held", async () => {
    const { pipeline } = makePipeline({
      readiness: async () => true,
      smoke: async () => ({ ok: false, logs: "homepage 500" }),
    });
    const r = await pipeline.verify();
    expect(r.ok).toBe(false);
    expect(r.logs).toMatch(/homepage 500/);
  });

  it("passes trivially when no probes are configured", async () => {
    const { pipeline } = makePipeline({});
    expect(await pipeline.verify()).toEqual({ ok: true });
  });
});
