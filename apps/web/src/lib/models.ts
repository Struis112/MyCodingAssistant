// Heuristic ranking for the Settings model picker.
//
// The list returned by /api/models is the provider's raw output. Users want
// the picker to surface the strongest + freshest models on top and put the
// model they last used at the very top. This module is the source of truth
// for that ordering and is unit-tested in models.test.ts.

export interface ModelLike {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

// 4 = frontier (Opus / GPT-5 / o3 / o4-class)
// 3 = strong   (Sonnet / GPT-4o / Grok 4 / Gemini Pro / DeepSeek R1)
// 2 = mid      (Haiku / GPT-4 / Gemini Flash / Llama 3 / o1)
// 1 = small    (everything else, including embeddings + tiny models)
export function getModelTier(model: ModelLike): number {
  const s = (model.id + " " + model.name).toLowerCase();
  if (/\bopus\b|\bgpt-?5\b|\bo3\b|\bo4(?!\d)/i.test(s)) return 4;
  if (/\bsonnet\b|\bgpt-?4o\b|\bgrok-?4\b|gemini.*pro|deepseek.*r1/i.test(s)) return 3;
  if (/\bhaiku\b|\bgpt-?4\b|gemini.*flash|llama-?3|\bo1\b/i.test(s)) return 2;
  return 1;
}

// Extract a YYYYMMDD release date from the model id.
//   claude-sonnet-4-5-20250929  -> "20250929"
//   claude-3-5-haiku-latest     -> "99999999" (treat as newest)
//   gpt-4o                      -> "00000000"
export function getReleaseDate(model: ModelLike): string {
  const dateMatch = model.id.match(/(\d{8})/);
  if (dateMatch) return dateMatch[1]!;
  if (/latest/i.test(model.id)) return "99999999";
  return "00000000";
}

export function isRecentlyReleased(model: ModelLike, withinDays = 120): boolean {
  const d = getReleaseDate(model);
  if (d === "00000000") return false;
  if (d === "99999999") return true;
  const year = parseInt(d.slice(0, 4), 10);
  const month = parseInt(d.slice(4, 6), 10) - 1;
  const day = parseInt(d.slice(6, 8), 10);
  const released = new Date(year, month, day).getTime();
  if (Number.isNaN(released)) return false;
  return Date.now() - released < withinDays * 24 * 60 * 60 * 1000;
}

// Two-criteria sort:
//   1. Last-used model first (always at the top)
//   2. Newest release date desc (uses the YYYYMMDD stamp embedded in the
//      model id; '-latest' aliases are treated as newest, undated models
//      sink to the bottom)
//   3. Name asc as a stable tiebreaker for identically-dated models
export function sortModels<T extends ModelLike>(models: readonly T[], lastUsedId?: string): T[] {
  return [...models].sort((a, b) => {
    const aLast = lastUsedId && a.id === lastUsedId ? 1 : 0;
    const bLast = lastUsedId && b.id === lastUsedId ? 1 : 0;
    if (aLast !== bLast) return bLast - aLast;

    const dateDiff = getReleaseDate(b).localeCompare(getReleaseDate(a));
    if (dateDiff !== 0) return dateDiff;

    return a.name.localeCompare(b.name);
  });
}

export type ModelBadge = "last-used" | "best" | "new";

// Decide which badges to show next to each model in the picker.
export function getBadges(
  model: ModelLike,
  allModels: readonly ModelLike[],
  lastUsedId?: string,
): ModelBadge[] {
  const badges: ModelBadge[] = [];
  if (lastUsedId && model.id === lastUsedId) badges.push("last-used");
  const maxTier = allModels.reduce((max, m) => Math.max(max, getModelTier(m)), 0);
  if (getModelTier(model) === maxTier && maxTier >= 3) badges.push("best");
  if (isRecentlyReleased(model)) badges.push("new");
  return badges;
}
