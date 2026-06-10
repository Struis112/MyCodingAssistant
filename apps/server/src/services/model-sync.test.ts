import { describe, expect, it } from "vitest";
import { customEntryFor, mergeIntoModelsJson, newModels } from "./model-sync.js";

describe("newModels", () => {
  it("returns only models the registry doesn't already know", () => {
    const live = [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { id: "claude-fable-5", name: "Claude Fable 5" },
    ];
    const result = newModels(live, ["claude-opus-4-5", "claude-sonnet-4-5"]);
    expect(result.map((m) => m.id)).toEqual(["claude-fable-5"]);
  });

  it("dedupes and skips empty ids", () => {
    const live = [
      { id: "x", name: "X" },
      { id: "x", name: "X dup" },
      { id: "", name: "blank" },
    ];
    expect(newModels(live, []).map((m) => m.id)).toEqual(["x"]);
  });
});

describe("customEntryFor", () => {
  it("copies behavior fields from the template and forces adaptive thinking", () => {
    const entry = customEntryFor(
      { id: "claude-fable-5", name: "Claude Fable 5" },
      {
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 64000,
        thinkingLevelMap: { off: null },
      },
    );
    expect(entry.id).toBe("claude-fable-5");
    expect(entry.name).toBe("Claude Fable 5");
    expect(entry.contextWindow).toBe(200000);
    expect(entry.maxTokens).toBe(64000);
    expect(entry.thinkingLevelMap).toEqual({ off: null });
    expect((entry.compat as Record<string, unknown>).forceAdaptiveThinking).toBe(true);
  });

  it("falls back to sane defaults when the template is empty", () => {
    const entry = customEntryFor({ id: "m", name: "" }, {});
    expect(entry.name).toBe("m");
    expect(entry.reasoning).toBe(true);
    expect(entry.input).toEqual(["text", "image"]);
    expect(entry.contextWindow).toBe(200000);
  });
});

describe("mergeIntoModelsJson", () => {
  it("adds new models under the provider without touching built-ins/other config", () => {
    const merged = mergeIntoModelsJson({ otherKey: 1 }, "anthropic", [
      { id: "claude-fable-5", name: "Claude Fable 5" },
    ]);
    expect(merged.otherKey).toBe(1);
    expect(merged.providers?.anthropic.models?.map((m) => m.id)).toEqual(["claude-fable-5"]);
  });

  it("upserts by id and preserves existing entries", () => {
    const existing = {
      providers: {
        anthropic: {
          models: [
            { id: "keep-me", name: "Keep" },
            { id: "m", name: "old" },
          ],
        },
      },
    };
    const merged = mergeIntoModelsJson(existing, "anthropic", [{ id: "m", name: "new" }]);
    const models = merged.providers?.anthropic.models ?? [];
    expect(models.map((m) => m.id)).toEqual(["keep-me", "m"]);
    expect(models.find((m) => m.id === "m")?.name).toBe("new");
    // input not mutated
    expect(existing.providers.anthropic.models.find((m) => m.id === "m")?.name).toBe("old");
  });
});
