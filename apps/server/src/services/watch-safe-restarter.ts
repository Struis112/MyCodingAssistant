// Watch-safe restarter
//
// "Dev, but idle-gated." In dev mode `tsx watch` restarts the API the instant a
// server source file changes — even mid-reply, cutting off the assistant's
// stream. Watch-safe instead watches the server source itself, debounces, and
// then restarts ONLY when no chat turn is streaming, so an in-progress reply is
// never interrupted. The restart picks up the new code (the entry runs under
// plain `tsx`, no `--watch`).
//
// The decision logic (`createRestartGate`) is separated from the filesystem
// watcher so it can be unit-tested with fake timers and injected dependencies.

import { watch, type FSWatcher } from "node:fs";

export interface RestartGateOptions {
  /** How many chat turns are currently streaming. 0 = idle (safe to restart). */
  activeTurns: () => number;
  /** Invoked once when it's safe to restart. Should trigger a graceful restart. */
  onRestart: () => void;
  /** Quiet period after the last change before we consider restarting. */
  debounceMs?: number;
  /** How often to re-check for idle while a turn is in flight. */
  idlePollMs?: number;
  /**
   * Safety valve: if turns are *still* streaming after this long, restart anyway
   * (a turn streaming this long is almost certainly stuck). Generous by default
   * so real long replies are never cut off.
   */
  maxWaitMs?: number;
  log?: (msg: string) => void;
}

export interface RestartGate {
  /** Call when a watched source file changed. */
  notifyChange: () => void;
  /** True once a restart has been triggered (gate is spent). */
  isSpent: () => boolean;
}

/**
 * Debounces source-change notifications and triggers `onRestart` exactly once,
 * waiting for `activeTurns() === 0` (or the `maxWaitMs` safety valve).
 */
export function createRestartGate(opts: RestartGateOptions): RestartGate {
  const debounceMs = opts.debounceMs ?? 400;
  const idlePollMs = opts.idlePollMs ?? 1_000;
  const maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;
  const log = opts.log ?? (() => {});

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let waitStart = 0;
  let spent = false;

  function tryRestart(): void {
    if (spent) return;
    const active = opts.activeTurns();
    const waited = Date.now() - waitStart;
    if (active > 0 && waited < maxWaitMs) {
      log(`${active} turn(s) streaming — waiting to restart (${Math.round(waited / 1000)}s)`);
      setTimeout(tryRestart, idlePollMs);
      return;
    }
    if (active > 0) {
      log(
        `still ${active} turn(s) streaming after ${Math.round(maxWaitMs / 1000)}s — restarting anyway`,
      );
    } else {
      log("idle — restarting to load new server code");
    }
    spent = true;
    pending = false;
    opts.onRestart();
  }

  function notifyChange(): void {
    if (spent) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (pending) return; // already counting down to a restart
      pending = true;
      waitStart = Date.now();
      log("server source changed — will restart when idle");
      tryRestart();
    }, debounceMs);
  }

  return { notifyChange, isSpent: () => spent };
}

export interface WatchSafeOptions extends RestartGateOptions {
  /** Directories to watch recursively for server source changes. */
  watchDirs: string[];
}

const SOURCE_RE = /\.(ts|tsx|js|mjs|cjs|json)$/;

/** Wires a recursive fs watcher over `watchDirs` to a single restart gate. */
export function startWatchSafe(opts: WatchSafeOptions): () => void {
  const log = opts.log ?? (() => {});
  const gate = createRestartGate(opts);
  const watchers: FSWatcher[] = [];

  for (const dir of opts.watchDirs) {
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && SOURCE_RE.test(filename.toString())) gate.notifyChange();
      });
      watchers.push(w);
    } catch (err) {
      log(`failed to watch ${dir}: ${(err as Error).message}`);
    }
  }
  log(`watching ${watchers.length}/${opts.watchDirs.length} dir(s) for server changes`);
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* best effort */
      }
    }
  };
}
