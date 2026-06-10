// Multi-service deploy pipeline (Phase 4 adapter)
//
// `DeployController` operates on a single `DeployPipeline`, but a real change
// often touches several services (today: api + web; tomorrow: more). Phase 4
// of docs/architecture/self-healing-deploy.md says: "Bring `api` + `packages/
// shared` under the contract". This composite is how.
//
// Semantics — each phase runs across ALL child pipelines in declared order;
// the first failure short-circuits and is what the controller sees:
//
//   build()    -> each child.build()
//   validate() -> each child.validate()
//   activate() -> each child.activate()   (order matters; see below)
//   verify()   -> each child.verify()     (order matters; see below)
//
// Why sequential, in order:
//   * Build/validate are cheap to keep predictable: a downstream failure is
//     identical regardless of which child surfaces it first.
//   * Activate MUST be ordered so the dependency restarts before its dependant.
//     Caller decides (e.g. ["api", "web"] — restart API first so the web
//     reconnects cleanly to the new contract).
//   * Verify is ordered to match: confirm the foundation is stable before we
//     even start probing the layer above it.
//
// Failure surface: the logs returned by the first failing child are prefixed
// with `[<name>]` so the controller's repair-log carries enough context for
// the AI to know *which* service broke. Everything else is unchanged from
// `ServiceDeployPipeline`, including its rollback semantics — when the
// controller calls `knownGood.rollback()`, the composed store is expected to
// restore the working tree once, and per-child build/activate is handled by
// that rollback path (the deployer wires this exactly as it does today for web).

import type { DeployPipeline, StepResult } from "./deploy-controller.js";

export interface NamedPipeline {
  /** Short stable id used to prefix logs and identify the failing child. */
  name: string;
  pipeline: DeployPipeline;
}

export interface MultiServiceDeployPipelineOptions {
  /**
   * Children, in the activation order: dependencies first. The same order is
   * used for build/validate/verify so the failure surface is predictable.
   */
  children: NamedPipeline[];
}

export class MultiServiceDeployPipeline implements DeployPipeline {
  private readonly children: NamedPipeline[];

  constructor(opts: MultiServiceDeployPipelineOptions) {
    if (opts.children.length === 0) {
      throw new Error("MultiServiceDeployPipeline requires at least one child");
    }
    this.children = opts.children;
  }

  async build(): Promise<StepResult> {
    return this.runEach((c) => c.pipeline.build());
  }

  async validate(): Promise<StepResult> {
    return this.runEach((c) => c.pipeline.validate());
  }

  async activate(): Promise<StepResult> {
    return this.runEach((c) => c.pipeline.activate());
  }

  async verify(): Promise<StepResult> {
    return this.runEach((c) => c.pipeline.verify());
  }

  /**
   * Run `step` across every child in order, stopping at the first failure and
   * tagging its logs with the child's name. Pure helper — no shared state.
   */
  private async runEach(step: (child: NamedPipeline) => Promise<StepResult>): Promise<StepResult> {
    for (const child of this.children) {
      // eslint-disable-next-line no-await-in-loop
      const r = await step(child);
      if (!r.ok) {
        return { ok: false, logs: `[${child.name}] ${r.logs ?? "step failed"}` };
      }
    }
    return { ok: true };
  }
}
