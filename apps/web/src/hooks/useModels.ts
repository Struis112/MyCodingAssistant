"use client";

import useSWR from "swr";

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:7641";

/**
 * Fetch the list of available models with SWR caching. The cache is
 * persisted to localStorage (see swr-provider.tsx) so the picker renders
 * instantly on subsequent loads. Revalidates every 5 minutes in the
 * background because new models rarely appear.
 */
export function useModels() {
  return useSWR<Model[]>(`${SERVER_URL}/api/models`, {
    refreshInterval: 5 * 60 * 1000, // 5 min
  });
}
