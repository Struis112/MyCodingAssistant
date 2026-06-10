import { describe, expect, it, vi } from "vitest";
import type { DeployPipeline, StepResult } from "./deploy-controller.js";
import { MultiServiceDeployPipeline } from "./multi-service-deploy-pipeline.js";

function fake(name: string, results: Partial<Record<keyof DeployPipeline, StepResult>>) {
  const ok: StepResult = { ok: true };
  const pipeline: DeployPipeline = {
    build: vi.fn(async () => results.build ?? ok),
    validate: vi.fn(async () => results.validate ?? ok),
    activate: vi.fn(async () => results.activate ?? ok),
    verify: vi.fn(async () => results.verify ?? ok),
  };
  return { name, pipeline };
}

describe("MultiServiceDeployPipeline", () => {
  it("runs every child step in order when all succeed", async () => {
    const a = fake("api", {});
    const b = fake("web", {});
    const composite = new MultiServiceDeployPipeline({ children: [a, b] });

    expect((await composite.build()).ok).toBe(true);
    expect((await composite.validate()).ok).toBe(true);
    expect((await composite.activate()).ok).toBe(true);
    expect((await composite.verify()).ok).toBe(true);

    for (const step of ["build", "validate", "activate", "verify"] as const) {
      expect(a.pipeline[step]).toHaveBeenCalledOnce();
      expect(b.pipeline[step]).toHaveBeenCalledOnce();
    }
  });

  it("short-circuits at the first failing child and tags the logs", async () => {
    const a = fake("api", { validate: { ok: false, logs: "TS2307: missing module" } });
    const b = fake("web", {});
    const composite = new MultiServiceDeployPipeline({ children: [a, b] });

    const r = await composite.validate();
    expect(r.ok).toBe(false);
    expect(r.logs).toMatch(/^\[api\] /);
    expect(r.logs).toContain("TS2307");
    // Downstream child never ran.
    expect(b.pipeline.validate).not.toHaveBeenCalled();
  });

  it("respects activation order (dependency before dependant)", async () => {
    const order: string[] = [];
    const a = fake("api", {});
    const b = fake("web", {});
    (a.pipeline.activate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("api");
      return { ok: true };
    });
    (b.pipeline.activate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("web");
      return { ok: true };
    });
    const composite = new MultiServiceDeployPipeline({ children: [a, b] });
    await composite.activate();
    expect(order).toEqual(["api", "web"]);
  });

  it("rejects construction with no children", () => {
    expect(() => new MultiServiceDeployPipeline({ children: [] })).toThrow();
  });
});
