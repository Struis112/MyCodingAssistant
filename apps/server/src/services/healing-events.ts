// Self-healing event feed
//
// Every self-healing action in the stack (deploy promote/rollback/park,
// watch-safe deferrals and restarts, model quarantine, watchdog checks)
// records a short human-readable event here. The Services screen shows the
// recent list so "is self-healing actually doing anything?" has a visible
// answer. Ring buffer persisted to a small JSON file — the feed must survive
// the very restarts it reports (watch-safe records, then the process exits).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface HealingEvent {
  at: number;
  /** Which subsystem acted: deploy | watch-safe | watchdog | model-health | supervisor */
  source: string;
  /** Short machine-ish kind: promoted | rolled-back | parked | restart | deferred | quarantined ... */
  kind: string;
  /** One plain-language sentence for the UI. */
  message: string;
}

const CAP = 200;
let storePath = path.join(process.cwd(), "logs", "mca-healing-events.json");
let events: HealingEvent[] | null = null;

/** Override the persistence path (tests). Resets the in-memory buffer. */
export function configureHealingEventStore(filePath: string): void {
  storePath = filePath;
  events = null;
}

function load(): HealingEvent[] {
  if (!events) {
    events = [];
    try {
      if (existsSync(storePath)) {
        const parsed = JSON.parse(readFileSync(storePath, "utf8"));
        if (Array.isArray(parsed)) events = parsed.slice(-CAP) as HealingEvent[];
      }
    } catch {
      /* corrupted — start empty */
    }
  }
  return events;
}

export function recordHealingEvent(e: Omit<HealingEvent, "at"> & { at?: number }): void {
  const list = load();
  list.push({ at: e.at ?? Date.now(), source: e.source, kind: e.kind, message: e.message });
  if (list.length > CAP) list.splice(0, list.length - CAP);
  try {
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(list, null, 2) + "\n");
  } catch {
    /* best effort — observability only */
  }
}

/** Newest first. */
export function listHealingEvents(limit = 50): HealingEvent[] {
  return load().slice(-limit).reverse();
}

/** Tests only. */
export function clearHealingEvents(): void {
  events = [];
}
