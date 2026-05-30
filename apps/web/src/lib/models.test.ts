import { describe, expect, it } from "vitest";
import { getBadges, getModelTier, getReleaseDate, sortModels, type ModelLike } from "./models";

const m = (id: string, name: string, provider = "anthropic"): ModelLike => ({ id, name, provider });

describe("getModelTier", () => {
  it("frontier names get tier 4", () => {
    expect(getModelTier(m("claude-opus-4-5-20250929", "Claude Opus 4.5"))).toBe(4);
    expect(getModelTier(m("o3", "OpenAI o3", "openai"))).toBe(4);
    expect(getModelTier(m("gpt-5", "GPT-5", "openai"))).toBe(4);
  });

  it("strong tier names get tier 3", () => {
    expect(getModelTier(m("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"))).toBe(3);
    expect(getModelTier(m("gpt-4o", "GPT-4o", "openai"))).toBe(3);
    expect(getModelTier(m("gemini-2.5-pro", "Gemini 2.5 Pro", "google"))).toBe(3);
  });

  it("mid tier names get tier 2", () => {
    expect(getModelTier(m("claude-3-5-haiku-latest", "Claude Haiku 3.5"))).toBe(2);
    expect(getModelTier(m("gemini-2.0-flash", "Gemini 2.0 Flash", "google"))).toBe(2);
    expect(getModelTier(m("o1", "OpenAI o1", "openai"))).toBe(2);
  });

  it("unknown / small models get tier 1", () => {
    expect(getModelTier(m("text-embedding-3-large", "embed", "openai"))).toBe(1);
    expect(getModelTier(m("some-weird-model", "Some Weird Model"))).toBe(1);
  });
});

describe("getReleaseDate", () => {
  it("extracts YYYYMMDD from id", () => {
    expect(getReleaseDate(m("claude-sonnet-4-5-20250929", ""))).toBe("20250929");
  });

  it("treats *-latest as newest", () => {
    expect(getReleaseDate(m("claude-3-5-haiku-latest", ""))).toBe("99999999");
  });

  it("returns sentinel when no date in id", () => {
    expect(getReleaseDate(m("gpt-4o", ""))).toBe("00000000");
  });
});

describe("sortModels", () => {
  const sonnetNewest = m("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5");
  const haikuMid = m("claude-3-5-haiku-20241022", "Claude Haiku 3.5");
  const sonnetOlder = m("claude-3-5-sonnet-20240620", "Claude Sonnet 3.5");
  const opusOldest = m("claude-opus-3-20240229", "Claude Opus 3 (old)");
  const undated = m("some-model", "Some Undated Model");
  const latest = m("claude-3-5-haiku-latest", "Claude Haiku 3.5 (latest)");
  const all = [opusOldest, sonnetNewest, undated, sonnetOlder, haikuMid, latest];

  it("puts the last-used model at the top regardless of date", () => {
    const out = sortModels(all, opusOldest.id);
    expect(out[0]).toBe(opusOldest);
  });

  it("sorts strictly by date descending when no last-used match", () => {
    const out = sortModels(all);
    // 'latest' alias wins (treated as newest)
    expect(out[0]).toBe(latest);
    // then the 2025-09-29 model
    expect(out[1]).toBe(sonnetNewest);
    // then 2024-10-22
    expect(out[2]).toBe(haikuMid);
    // then 2024-06-20
    expect(out[3]).toBe(sonnetOlder);
    // then 2024-02-29
    expect(out[4]).toBe(opusOldest);
    // undated sinks to the bottom
    expect(out[5]).toBe(undated);
  });

  it("keeps last-used first, then orders the rest by date desc", () => {
    const out = sortModels(all, sonnetOlder.id);
    expect(out[0]).toBe(sonnetOlder);
    expect(out[1]).toBe(latest);
    expect(out[2]).toBe(sonnetNewest);
    expect(out[3]).toBe(haikuMid);
    expect(out[4]).toBe(opusOldest);
    expect(out[5]).toBe(undated);
  });

  it("does not mutate the input array", () => {
    const input = [haikuMid, sonnetOlder, sonnetNewest];
    const before = [...input];
    sortModels(input);
    expect(input).toEqual(before);
  });
});

describe("getBadges", () => {
  const opus = m("claude-opus-4-5-20250929", "Claude Opus 4.5");
  const sonnet = m("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5");
  const oldHaiku = m("claude-3-5-haiku-20200101", "Claude Haiku 3.5");
  const all = [opus, sonnet, oldHaiku];

  it("flags last-used", () => {
    expect(getBadges(sonnet, all, sonnet.id)).toContain("last-used");
    expect(getBadges(opus, all, sonnet.id)).not.toContain("last-used");
  });

  it("flags the highest-tier model as best", () => {
    expect(getBadges(opus, all)).toContain("best");
    expect(getBadges(sonnet, all)).not.toContain("best");
  });

  it("does not call anything best if the highest tier is mid (2)", () => {
    expect(getBadges(oldHaiku, [oldHaiku])).not.toContain("best");
  });

  it("flags a recent date as new", () => {
    // Use a fixed-very-recent date string so the test isn't time-flaky:
    // build a date 5 days ago.
    const five = new Date();
    five.setDate(five.getDate() - 5);
    const yyyymmdd =
      five.getFullYear().toString().padStart(4, "0") +
      (five.getMonth() + 1).toString().padStart(2, "0") +
      five.getDate().toString().padStart(2, "0");
    const recent = m(`some-model-${yyyymmdd}`, "Recent Model");
    expect(getBadges(recent, [recent])).toContain("new");
  });

  it("does not flag old dates as new", () => {
    expect(getBadges(oldHaiku, [oldHaiku])).not.toContain("new");
  });
});
