// Claude status feed
//
// Fetches https://status.claude.com/history.rss server-side (the browser can't,
// due to CORS), keeps only incidents updated within the last 48h, and caches the
// result so we never hammer the feed. The header shows nothing when this is
// empty — it's a quiet, only-when-relevant indicator.

const STATUS_RSS_URL = process.env.MCA_CLAUDE_STATUS_URL || "https://status.claude.com/history.rss";
const MAX_AGE_MS = 48 * 60 * 60_000; // 48 hours
const CACHE_TTL_MS = 5 * 60_000; // refresh at most every 5 min
const MAX_ITEMS = 8;

export interface StatusIncident {
  title: string;
  url: string;
  /** ISO date of the item's pubDate. */
  date: string;
  /** Hours since pubDate (rounded to 1 decimal). */
  ageHours: number;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])) : "";
}

/**
 * Parse a Statuspage history.rss document into recent incidents. Pure (now +
 * maxAge are injectable) so it's unit-testable. Returns newest first, capped.
 */
export function parseStatusRss(
  xml: string,
  now: number = Date.now(),
  maxAgeMs: number = MAX_AGE_MS,
): StatusIncident[] {
  const out: StatusIncident[] = [];
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const title = tag(item, "title");
    const url = tag(item, "link");
    const pub = tag(item, "pubDate");
    const t = pub ? Date.parse(pub) : NaN;
    if (!title || !Number.isFinite(t)) continue;
    const age = now - t;
    if (age < 0 || age > maxAgeMs) continue; // skip future + anything older than 48h
    out.push({
      title,
      url: url || STATUS_RSS_URL,
      date: new Date(t).toISOString(),
      ageHours: Math.round((age / 3_600_000) * 10) / 10,
    });
  }
  out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return out.slice(0, MAX_ITEMS);
}

let cache: { at: number; incidents: StatusIncident[] } | null = null;

/** Cached fetch of recent Claude-status incidents. Never throws. */
export async function getClaudeStatus(): Promise<{
  incidents: StatusIncident[];
  fetchedAt: number;
}> {
  const nowMs = Date.now();
  if (cache && nowMs - cache.at < CACHE_TTL_MS) {
    return { incidents: cache.incidents, fetchedAt: cache.at };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(STATUS_RSS_URL, {
      headers: { "User-Agent": "MyCodingAssistant/1.0", Accept: "application/rss+xml, text/xml" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const incidents = parseStatusRss(await res.text(), Date.now());
    cache = { at: Date.now(), incidents };
    return { incidents, fetchedAt: cache.at };
  } catch {
    // On failure keep serving the last good result (if any) rather than flapping.
    if (cache) return { incidents: cache.incidents, fetchedAt: cache.at };
    return { incidents: [], fetchedAt: nowMs };
  }
}
