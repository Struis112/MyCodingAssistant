// Health Watchdog
//
// Watches the ServiceRegistry's status and, when a service is unhealthy for
// long enough (default: it has reached `failed` — i.e. the supervisor's own
// self-repair already gave up), emits a structured `repair-needed` request with
// the recent logs. That request is the hook the AI repair loop consumes ("read
// the logs, fix it, keep going until stable") in either run mode.
//
// It is deliberately decoupled and side-effect-free: status/logs/clock are
// injected and it only emits an event. Wiring (log it, surface it in chat,
// drive the AI) is the caller's job — so this core stays unit-testable and
// can't itself destabilise anything.

import type { LogLine, ServiceState, ServiceStatus } from "./service-supervisor.js";

export interface RepairNeeded {
  service: string;
  state: ServiceState;
  /** Recent log lines for the failing service, to hand to the AI. */
  logs: LogLine[];
  /** When we first saw it unhealthy (ms epoch). */
  since: number;
  /** When this request was emitted (ms epoch). */
  detectedAt: number;
}

export interface HealthWatchdogOptions {
  getStatuses: () => ServiceStatus[];
  getLogs: (name: string) => LogLine[];
  onRepairNeeded: (req: RepairNeeded) => void;
  /** States considered unhealthy. Default: ["failed"]. */
  unhealthyStates?: ServiceState[];
  /**
   * How long a service must stay unhealthy before we ask for repair. Avoids
   * firing on transient blips (e.g. a normal restart passing through backoff).
   */
  debounceMs?: number;
  /** Don't re-ask for the same service within this window after emitting. */
  cooldownMs?: number;
  now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

interface Tracked {
  since: number;
  /** When we last emitted a repair request (0 = never this episode). */
  notifiedAt: number;
}

export class HealthWatchdog {
  private getStatuses: () => ServiceStatus[];
  private getLogs: (name: string) => LogLine[];
  private onRepairNeeded: (req: RepairNeeded) => void;
  private unhealthy: Set<ServiceState>;
  private debounceMs: number;
  private cooldownMs: number;
  private now: () => number;

  /** Per-service health episode tracking. Cleared when a service recovers. */
  private tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: HealthWatchdogOptions) {
    this.getStatuses = opts.getStatuses;
    this.getLogs = opts.getLogs;
    this.onRepairNeeded = opts.onRepairNeeded;
    this.unhealthy = new Set(opts.unhealthyStates ?? ["failed"]);
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * One evaluation pass. Returns the repair requests emitted this pass (also
   * delivered via `onRepairNeeded`), so callers/tests can react synchronously.
   */
  check(): RepairNeeded[] {
    const now = this.now();
    const emitted: RepairNeeded[] = [];
    const seen = new Set<string>();

    for (const status of this.getStatuses()) {
      seen.add(status.name);
      const isUnhealthy = this.unhealthy.has(status.state);

      if (!isUnhealthy) {
        // Recovered (or healthy): forget the episode so a future failure
        // notifies again.
        this.tracked.delete(status.name);
        continue;
      }

      const prior = this.tracked.get(status.name);
      if (!prior) {
        this.tracked.set(status.name, { since: now, notifiedAt: 0 });
        continue;
      }

      const heldLongEnough = now - prior.since >= this.debounceMs;
      const outOfCooldown = prior.notifiedAt === 0 || now - prior.notifiedAt >= this.cooldownMs;
      if (heldLongEnough && outOfCooldown) {
        prior.notifiedAt = now;
        const req: RepairNeeded = {
          service: status.name,
          state: status.state,
          logs: this.getLogs(status.name),
          since: prior.since,
          detectedAt: now,
        };
        emitted.push(req);
        this.onRepairNeeded(req);
      }
    }

    // Drop tracking for services that no longer exist.
    for (const name of [...this.tracked.keys()]) {
      if (!seen.has(name)) this.tracked.delete(name);
    }

    return emitted;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
