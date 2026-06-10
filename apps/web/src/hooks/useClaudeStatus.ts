"use client";

import useSWR from "swr";
import { SERVER_URL } from "@/lib/api";

export interface StatusIncident {
  title: string;
  url: string;
  date: string;
  ageHours: number;
}

/**
 * Recent Claude-status incidents (last 48h), fetched + cached server-side from
 * status.claude.com. Refreshes every 5 minutes; the feed rarely changes.
 */
export function useClaudeStatus() {
  return useSWR<{ incidents: StatusIncident[]; fetchedAt: number }>(
    `${SERVER_URL}/api/claude-status`,
    { refreshInterval: 5 * 60 * 1000 },
  );
}
