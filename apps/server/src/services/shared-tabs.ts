// Shared tab list (cross-device + future-proofed for multi-user).
//
// The tabs you have open follow you between devices: open a chat on the
// desktop, see it on the laptop. Stored per-user (`scope`) so that when a
// second account ever shows up its tabs don't leak to the first. Today every
// client lands in the `"default"` scope; the wire format and persistence are
// already keyed by user, so adding auth later is one-line at the client.
//
// Persistence is debounced + atomic (write-temp + rename) so a flurry of
// reorders doesn't pin the disk and a mid-write crash never leaves a
// half-truncated JSON file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export type SharedTab = { sessionFile: string; name: string | null };

/** What we write to disk. v1 is `{ scopes: { [userId]: SharedTab[] } }`. */
type PersistedV1 = { version: 1; scopes: Record<string, SharedTab[]> };

/** The legacy on-disk shape (a flat array), before scoping was introduced. */
type PersistedLegacy = SharedTab[];

/** Default scope used when a client doesn't (yet) identify a user. */
export const DEFAULT_SCOPE = "default";

/** Sanitize untrusted input into a clean `SharedTab[]` (drop bad rows). */
export function sanitizeTabs(input: unknown): SharedTab[] {
  if (!Array.isArray(input)) return [];
  const out: SharedTab[] = [];
  for (const t of input) {
    if (!t || typeof t !== "object") continue;
    const tab = t as { sessionFile?: unknown; name?: unknown };
    if (typeof tab.sessionFile !== "string" || tab.sessionFile.length === 0) continue;
    out.push({
      sessionFile: tab.sessionFile,
      name: typeof tab.name === "string" ? tab.name : null,
    });
  }
  return out;
}

/** A small subset of `console` so tests can silence the logger. */
type Logger = { error: (...args: unknown[]) => void };

export interface SharedTabsStoreOptions {
  /** Debounce window for batched disk writes (ms). Default 200. */
  debounceMs?: number;
  /** Optional logger. Defaults to `console`. */
  logger?: Logger;
}

/**
 * Per-user tab list with debounced, atomic JSON persistence.
 *
 * Reads are O(1) (the whole map lives in memory). Writes are coalesced into
 * one flush per `debounceMs`; an in-flight flush is awaited by the next one
 * so callers never race on the temp file.
 */
export class SharedTabsStore {
  private readonly scopes = new Map<string, SharedTab[]>();
  private readonly filePath: string;
  private readonly debounceMs: number;
  private readonly logger: Logger;
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;

  constructor(filePath: string, options: SharedTabsStoreOptions = {}) {
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 200;
    this.logger = options.logger ?? console;
    this.loadFromDisk();
  }

  // ---- Reads ---------------------------------------------------------------

  /** The tabs for a single user. Returns a fresh array (safe to mutate). */
  get(scope: string): SharedTab[] {
    const tabs = this.scopes.get(scope) ?? [];
    return tabs.map((t) => ({ ...t }));
  }

  /** All known scopes — primarily used by tests + diagnostics. */
  scopesList(): string[] {
    return [...this.scopes.keys()];
  }

  // ---- Writes --------------------------------------------------------------

  /** Replace a user's tabs. Returns the sanitized list that was stored. */
  set(scope: string, tabs: unknown): SharedTab[] {
    const clean = sanitizeTabs(tabs);
    if (clean.length === 0) this.scopes.delete(scope);
    else this.scopes.set(scope, clean);
    this.scheduleFlush();
    return clean.map((t) => ({ ...t }));
  }

  /** Force any pending write to complete (call on shutdown / in tests). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.inFlight) await this.inFlight;
    if (!this.dirty) return;
    await this.runFlush();
  }

  /**
   * Synchronous flush for the SIGTERM/SIGINT path, where we don't get to
   * await async work. Best-effort and noisy on failure.
   */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, this.serialize());
      renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      this.logger.error("[tabs] sync flush failed:", err);
    }
  }

  // ---- Internals -----------------------------------------------------------

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Chain onto any in-flight write so we never race on the temp file.
      const prev = this.inFlight ?? Promise.resolve();
      this.inFlight = prev.then(() => this.runFlush());
    }, this.debounceMs);
    // Don't keep the event loop alive just to write tabs.
    this.flushTimer.unref?.();
  }

  private async runFlush(): Promise<void> {
    if (!this.dirty) return;
    // Snapshot what we're about to persist; if more edits arrive while we
    // write, `dirty` flips back on and the next debounce picks them up.
    this.dirty = false;
    const payload = this.serialize();
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, payload);
      await rename(tmp, this.filePath);
    } catch (err) {
      // Re-mark dirty so the next edit (or shutdown flush) retries.
      this.dirty = true;
      this.logger.error("[tabs] could not persist shared tabs:", err);
    } finally {
      this.inFlight = null;
    }
  }

  private serialize(): string {
    const scopes: Record<string, SharedTab[]> = {};
    for (const [k, v] of this.scopes) scopes[k] = v;
    const payload: PersistedV1 = { version: 1, scopes };
    return JSON.stringify(payload);
  }

  private loadFromDisk(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // missing file is fine — fresh start
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.error("[tabs] could not parse shared tabs file:", err);
      return;
    }
    // Legacy: a bare array → migrate into the default scope.
    if (Array.isArray(parsed)) {
      const tabs = sanitizeTabs(parsed as PersistedLegacy);
      if (tabs.length > 0) this.scopes.set(DEFAULT_SCOPE, tabs);
      // Mark dirty so the next flush rewrites in the new shape.
      this.dirty = true;
      return;
    }
    // v1: { version: 1, scopes: {...} }
    if (parsed && typeof parsed === "object" && "scopes" in parsed) {
      const scopes = (parsed as PersistedV1).scopes;
      if (scopes && typeof scopes === "object") {
        for (const [scope, tabs] of Object.entries(scopes)) {
          const clean = sanitizeTabs(tabs);
          if (clean.length > 0) this.scopes.set(scope, clean);
        }
      }
    }
  }
}
