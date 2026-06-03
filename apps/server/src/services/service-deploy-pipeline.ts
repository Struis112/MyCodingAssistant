// Service deploy pipeline (Phase 2 adapter)
//
// Maps the DeployController's four gated steps onto a real service:
//
//   build()    -> rebuild the candidate artifact
//   validate() -> typecheck + tests (the service's `validate` hook)
//   activate() -> restart the service to serve the candidate
//   verify()   -> readiness held for a STABILITY WINDOW, then a smoke test
//
// Everything is injected (the activatable service + the probe hooks + clock/
// sleep), so the verify timing logic is deterministic under test. The real
// wiring passes a ServiceSupervisor as the activatable and the service spec's
// validate/readiness/smoke as the probes.

import type { DeployPipeline, StepResult } from "./deploy-controller.js";

/** Minimal surface the pipeline needs to activate a candidate. */
export interface Activatable {
  restart(): Promise<void>;
}

/** The service's deploy-contract hooks (subset of ServiceSpec). */
export interface ServiceProbes {
  /** Build the candidate; throw on failure. */
  build?: () => Promise<void>;
  /** Validate before activation (typecheck + tests). */
  validate?: () => Promise<{ ok: boolean; logs?: string }>;
  /** Readiness probe (is it serving right now?). */
  readiness?: () => Promise<boolean>;
  /** Smoke test after activation. */
  smoke?: () => Promise<{ ok: boolean; logs?: string }>;
}

export interface ServiceDeployPipelineOptions {
  service: Activatable;
  probes: ServiceProbes;
  /** Require readiness to hold for this long before calling it stable. */
  stabilityWindowMs?: number;
  /** Poll interval within the stability window. */
  probeIntervalMs?: number;
  /** Injectable sleep (tests). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_STABILITY_WINDOW_MS = 30_000;
const DEFAULT_PROBE_INTERVAL_MS = 3_000;

export class ServiceDeployPipeline implements DeployPipeline {
  private service: Activatable;
  private probes: ServiceProbes;
  private stabilityWindowMs: number;
  private probeIntervalMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: ServiceDeployPipelineOptions) {
    this.service = opts.service;
    this.probes = opts.probes;
    this.stabilityWindowMs = opts.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS;
    this.probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async build(): Promise<StepResult> {
    if (!this.probes.build) return { ok: true };
    try {
      await this.probes.build();
      return { ok: true };
    } catch (err) {
      return { ok: false, logs: `build failed: ${String(err)}` };
    }
  }

  async validate(): Promise<StepResult> {
    if (!this.probes.validate) return { ok: true };
    try {
      const r = await this.probes.validate();
      return { ok: r.ok, logs: r.logs };
    } catch (err) {
      return { ok: false, logs: `validate threw: ${String(err)}` };
    }
  }

  async activate(): Promise<StepResult> {
    try {
      await this.service.restart();
      return { ok: true };
    } catch (err) {
      return { ok: false, logs: `activation (restart) failed: ${String(err)}` };
    }
  }

  /**
   * Readiness must hold across the stability window (catches a service that
   * comes up then immediately falls over), followed by a smoke test. Any failed
   * probe fails verification, which the controller turns into a rollback.
   */
  async verify(): Promise<StepResult> {
    const readiness = this.probes.readiness;
    if (readiness) {
      const checks = Math.max(1, Math.ceil(this.stabilityWindowMs / this.probeIntervalMs));
      for (let i = 0; i < checks; i++) {
        let ready: boolean;
        try {
          // eslint-disable-next-line no-await-in-loop
          ready = await readiness();
        } catch (err) {
          return { ok: false, logs: `readiness probe threw: ${String(err)}` };
        }
        if (!ready) {
          return { ok: false, logs: "readiness probe failed during the stability window" };
        }
        if (i < checks - 1) {
          // eslint-disable-next-line no-await-in-loop
          await this.sleep(this.probeIntervalMs);
        }
      }
    }

    if (this.probes.smoke) {
      try {
        const s = await this.probes.smoke();
        if (!s.ok) return { ok: false, logs: s.logs ?? "smoke test failed" };
      } catch (err) {
        return { ok: false, logs: `smoke test threw: ${String(err)}` };
      }
    }

    return { ok: true };
  }
}
