"use client";

import { type ReactNode } from "react";
import { SWRConfig, type Cache } from "swr";
import { APP_VERSION } from "./version";

// localStorage-backed SWR cache. The key is version-prefixed, so a version
// bump (see version.ts) means previously-cached data is left behind and a
// fresh fetch happens on next visit. On boot we also prune any stale keys
// from older versions so they don't bloat localStorage forever.

const CACHE_KEY = `mca-swr-cache-v${APP_VERSION}`;
const CACHE_PREFIX = "mca-swr-cache-v";

// SWR's `provider` returns its own internal `Cache` interface, which is
// structurally a Map. We use a real Map but cast at the boundary so callers
// don't have to import SWR-internal `State` types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProvider(_initial: Readonly<Cache<any>>): Cache<any> {
  if (typeof window === "undefined") return new Map() as unknown as Cache<any>;

  // Drop any orphaned caches from previous versions.
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX) && key !== CACHE_KEY) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* private mode / quota */
  }

  // Hydrate the current-version cache.
  let entries: Array<[string, unknown]> = [];
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw) entries = JSON.parse(raw);
  } catch {
    entries = [];
  }
  const map = new Map<string, unknown>(entries);

  // Persist the cache when the tab is about to be closed.
  const flush = () => {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(Array.from(map.entries())));
    } catch {
      /* quota */
    }
  };
  window.addEventListener("beforeunload", flush);
  // Also flush on visibility hidden — covers mobile and background tabs.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  return map as unknown as Cache<any>;
}

const defaultFetcher = async (input: RequestInfo): Promise<unknown> => {
  const r = await fetch(input);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${String(input)}`);
  return r.json();
};

export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher: defaultFetcher,
        provider: buildProvider,
        // Don't refetch every time the tab regains focus — cached data is
        // shown immediately and we revalidate on connect / interval below.
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        // Coalesce duplicate requests for 5s.
        dedupingInterval: 5_000,
      }}
    >
      {children}
    </SWRConfig>
  );
}
