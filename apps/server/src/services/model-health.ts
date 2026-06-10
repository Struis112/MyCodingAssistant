// Model health / quarantine
//
// Some registry model ids are offered upstream (they appear in /v1/models)
// but return NO content when used for chat ("registry alias the provider
// doesn't actually serve"). A live-list filter can't catch these — so we use
// runtime evidence instead: every turn that ends with zero content events is
// a strike against the active model; after MAX_STRIKES consecutive empty
// turns the model is quarantined and hidden from the picker. One good turn
// clears the streak. Known-bad ids are seeded so users never hit them first.
//
// Persisted to a small JSON file so quarantine survives the (frequent)
// server restarts. Pure core (ModelHealth) + a file-backed singleton.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_STRIKES = 2;

/** Ids that repeatedly returned empty replies in testing (2026-06). */
export const SEED_QUARANTINE = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
];

interface Entry {
  emptyStreak: number;
  quarantinedAt?: number;
}

export interface ModelHealthSnapshot {
  [modelId: string]: Entry;
}

export class ModelHealth {
  private entries = new Map<string, Entry>();

  constructor(seedQuarantined: string[] = [], snapshot?: ModelHealthSnapshot) {
    for (const id of seedQuarantined) {
      this.entries.set(id, { emptyStreak: MAX_STRIKES, quarantinedAt: 0 });
    }
    if (snapshot) {
      for (const [id, e] of Object.entries(snapshot)) this.entries.set(id, { ...e });
    }
  }

  /** Record an empty (no-content) turn. Returns true if this NEWLY quarantined the model. */
  recordEmpty(modelId: string): boolean {
    const e = this.entries.get(modelId) ?? { emptyStreak: 0 };
    const wasQuarantined = e.emptyStreak >= MAX_STRIKES;
    e.emptyStreak += 1;
    if (!wasQuarantined && e.emptyStreak >= MAX_STRIKES) e.quarantinedAt = Date.now();
    this.entries.set(modelId, e);
    return !wasQuarantined && e.emptyStreak >= MAX_STRIKES;
  }

  /** Record a turn that produced content — clears the streak (and quarantine). */
  recordGood(modelId: string): void {
    if (this.entries.has(modelId)) this.entries.delete(modelId);
  }

  isQuarantined(modelId: string): boolean {
    return (this.entries.get(modelId)?.emptyStreak ?? 0) >= MAX_STRIKES;
  }

  quarantinedIds(): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.emptyStreak >= MAX_STRIKES)
      .map(([id]) => id);
  }

  toJSON(): ModelHealthSnapshot {
    return Object.fromEntries(this.entries);
  }
}

// ----- file-backed singleton -----

let instance: ModelHealth | null = null;
let storePath = path.join(process.cwd(), "logs", "mca-model-health.json");

/** Override the persistence path (tests). Resets the singleton. */
export function configureModelHealthStore(filePath: string): void {
  storePath = filePath;
  instance = null;
}

export function getModelHealth(): ModelHealth {
  if (!instance) {
    let snapshot: ModelHealthSnapshot | undefined;
    try {
      if (existsSync(storePath)) {
        snapshot = JSON.parse(readFileSync(storePath, "utf8")) as ModelHealthSnapshot;
      }
    } catch {
      /* corrupted store — start from seed */
    }
    instance = new ModelHealth(SEED_QUARANTINE, snapshot);
  }
  return instance;
}

export function saveModelHealth(): void {
  if (!instance) return;
  try {
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(instance.toJSON(), null, 2) + "\n");
  } catch {
    /* best effort */
  }
}
