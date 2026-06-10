// Model auto-sync
//
// The pi SDK ships a *static* model list, so brand-new provider models (and
// their effort/thinking levels) don't appear until the SDK updates. This keeps
// the picker current by querying the provider's authoritative API on a schedule
// and writing any newly-offered models into the user's models.json (merged into
// the built-in provider, so existing OAuth/API-key auth is reused).
//
// The decision/merge logic here is pure so it can be unit-tested; the IO
// (auth, fetch, fs, registry refresh) lives in the manager's syncLatestModels().

/** A model as returned by a provider's `/v1/models` list. */
export interface LiveModel {
  id: string;
  name: string;
}

/** Fields we copy from a known-good built-in model so new entries behave the same. */
export interface ModelTemplate {
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
  thinkingLevelMap?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface ModelEntry {
  id: string;
  name: string;
  [k: string]: unknown;
}

export interface ModelsJson {
  providers?: Record<string, { models?: ModelEntry[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Live models the registry doesn't already know about (by id). */
export function newModels(live: LiveModel[], knownIds: Iterable<string>): LiveModel[] {
  const known = new Set(knownIds);
  const seen = new Set<string>();
  return live.filter((m) => {
    if (!m.id || known.has(m.id) || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/**
 * Build a models.json entry for a newly-seen model, copying behavior fields from
 * a known-good template (so it gets the same context window, output cap and
 * effort/thinking levels as the latest built-in model). `compat.forceAdaptive
 * Thinking` is set because custom Anthropic aliases otherwise use the legacy
 * thinking payload that the newest models reject.
 */
export function customEntryFor(model: LiveModel, template: ModelTemplate): ModelEntry {
  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: template.reasoning ?? true,
    input: template.input ?? ["text", "image"],
    contextWindow: template.contextWindow ?? 200000,
    maxTokens: template.maxTokens ?? 64000,
    cost: template.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(template.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
    compat: { forceAdaptiveThinking: true, ...(template.compat ?? {}) },
  };
}

/**
 * Merge model entries into a provider's `models` array in a models.json object,
 * upserting by id and preserving everything else. Returns a new object (the
 * input is not mutated).
 */
export function mergeIntoModelsJson(
  existing: ModelsJson | null | undefined,
  provider: string,
  entries: ModelEntry[],
): ModelsJson {
  const out: ModelsJson = existing ? structuredClone(existing) : {};
  out.providers = out.providers ?? {};
  const p = (out.providers[provider] = out.providers[provider] ?? {});
  const models = (p.models = p.models ?? []);
  for (const entry of entries) {
    const i = models.findIndex((m) => m.id === entry.id);
    if (i >= 0) models[i] = entry;
    else models.push(entry);
  }
  return out;
}

export interface SyncResult {
  added: string[];
  totalOffered: number;
  error?: string;
  at: number;
}
