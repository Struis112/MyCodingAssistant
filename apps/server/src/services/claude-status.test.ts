import { describe, expect, it } from "vitest";
import { parseStatusRss, isResolved } from "./claude-status.js";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toUTCString();

const rss = (items: string) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
const item = (
  title: string,
  hoursAgo: number,
  description = "<strong>Investigating</strong> - looking into it",
  link = "https://status.claude.com/incidents/x",
) =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${iso(hoursAgo)}</pubDate>` +
  `<description><![CDATA[${description}]]></description></item>`;

describe("parseStatusRss", () => {
  it("keeps only items within the last 6h, newest first", () => {
    const xml = rss(item("Old outage", 8) + item("Recent degradation", 3) + item("Newer", 1));
    const out = parseStatusRss(xml, NOW);
    expect(out.map((i) => i.title)).toEqual(["Newer", "Recent degradation"]);
    expect(out[1].ageHours).toBe(3);
  });

  it("drops incidents whose latest update is Resolved/Completed", () => {
    const xml = rss(
      item(
        "Fixed already",
        1,
        "<strong>Resolved</strong> - all good <strong>Investigating</strong> - was bad",
      ) +
        item("Maintenance done", 2, "<strong>Completed</strong> - finished") +
        item(
          "Still active",
          1,
          "<strong>Monitoring</strong> - watching <strong>Resolved</strong> - older note",
        ),
    );
    expect(parseStatusRss(xml, NOW).map((i) => i.title)).toEqual(["Still active"]);
  });

  it("keeps incidents without a description (fail-open)", () => {
    const xml = rss(
      `<item><title>No desc</title><link>https://x</link><pubDate>${iso(1)}</pubDate></item>`,
    );
    expect(parseStatusRss(xml, NOW).map((i) => i.title)).toEqual(["No desc"]);
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

describe("isResolved", () => {
  it("reads the FIRST (newest) status keyword", () => {
    expect(isResolved("<strong>Resolved</strong> - ok <strong>Investigating</strong> - bad")).toBe(
      true,
    );
    expect(isResolved("<strong>Monitoring</strong> - eh <strong>Resolved</strong> - old")).toBe(
      false,
    );
  });
  it("is false when no status keyword exists", () => {
    expect(isResolved("")).toBe(false);
    expect(isResolved("something unrelated")).toBe(false);
  });
});
