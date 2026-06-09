"use client";

import useSWR from "swr";
import { SERVER_URL } from "@/lib/api";

export interface AccountUsage {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  resetsAt?: { fiveHourMs?: number; weeklyMs?: number };
}

/**
 * Anthropic account usage limits (5-hour + weekly), polled for the header.
 * The upstream endpoint is tightly rate-limited (~3 req / 5 min), so we poll
 * slowly (every 5 min) and the server caches + backs off on 429. Values are
 * null only on a cold first failure; the UI renders that as "—".
 */
export function useUsage() {
  return useSWR<AccountUsage>(`${SERVER_URL}/api/usage`, {
    refreshInterval: 5 * 60 * 1000,
    dedupingInterval: 5 * 60 * 1000,
  });
}
