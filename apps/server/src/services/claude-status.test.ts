import { describe, expect, it } from "vitest";
import { parseStatusRss } from "./claude-status.js";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toUTCString();

const rss = (items: string) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
const item = (title: string, hoursAgo: number, link = "https://status.claude.com/incidents/x") =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${iso(hoursAgo)}</pubDate></item>`;

describe("parseStatusRss", () => {
  it("keeps only items within the last 48h, newest first", () => {
    const xml = rss(item("Old outage", 60) + item("Recent degradation", 3) + item("Yesterday", 30));
    const out = parseStatusRss(xml, NOW);
    expect(out.map((i) => i.title)).toEqual(["Recent degradation", "Yesterday"]);
    expect(out[0].ageHours).toBe(3);
  });

  it("ignores future-dated and undated items", () => {
    const xml = rss(
      item("Future", -5) + "<item><title>No date</title></item>" + item("Now-ish", 1),
    );
    expect(parseStatusRss(xml, NOW).map((i) => i.title)).toEqual(["Now-ish"]);
  });

  it("strips CDATA and decodes entities in titles", () => {
    const xml = rss(
      `<item><title><![CDATA[API errors & latency]]></title><link>https://x</link><pubDate>${iso(2)}</pubDate></item>`,
    );
    expect(parseStatusRss(xml, NOW)[0].title).toBe("API errors & latency");
  });

  it("returns [] for empty / non-feed input", () => {
    expect(parseStatusRss("<rss></rss>", NOW)).toEqual([]);
    expect(parseStatusRss("garbage", NOW)).toEqual([]);
  });
});
