"use client";

import { useState, useEffect, useMemo } from "react";
import { useTheme } from "@/lib/theme";
import type { Theme } from "@/lib/theme-shared";

// Order mirrors the family pairs: Tokyo (original) first, then shadcn.
const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "dark", label: "Tokyo · Dark" },
  { value: "light", label: "Tokyo · Light" },
  { value: "shadcn-dark", label: "shadcn · Dark" },
  { value: "shadcn-light", label: "shadcn · Light" },
];
import { useFont, FONT_CHOICES } from "@/lib/font";
import { getSocket } from "@/lib/socket";
import { useAppStore } from "@/lib/store";
import { getBadges, sortModels, type ModelBadge } from "@/lib/models";
import { useModels, type Model } from "@/hooks/useModels";
import {
  Settings as SettingsIcon,
  Palette,
  Type,
  Brain,
  Cpu,
  CheckCircle2,
  Loader2,
  Star,
  Sparkles,
  History,
  RefreshCw,
} from "lucide-react";

function ModelBadgePill({ kind }: { kind: ModelBadge }) {
  const config: Record<ModelBadge, { icon: typeof Star; label: string; className: string }> = {
    best: {
      icon: Star,
      label: "Best",
      className: "bg-primary/15 text-primary border-primary/30",
    },
    new: {
      icon: Sparkles,
      label: "New",
      className: "bg-success/15 text-success border-success/30",
    },
    "last-used": {
      icon: History,
      label: "Last used",
      className: "bg-muted text-muted-foreground border-border",
    },
  };
  const { icon: Icon, label, className } = config[kind];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border rounded ${className}`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

export function Settings() {
  const { theme, setTheme } = useTheme();
  const { font, setFont } = useFont();
  const {
    activeSessionId: sessionId,
    currentModel,
    setCurrentModel,
    thinkingLevel,
    setThinkingLevel,
  } = useAppStore();

  // Models load from SWR with localStorage cache, so the picker renders
  // instantly on subsequent visits and revalidates every 5 minutes in the
  // background. See lib/swr-provider.tsx + hooks/useModels.ts.
  const {
    data: modelsData,
    isLoading: loading,
    mutate: refreshModels,
    error: modelsError,
  } = useModels();
  const models = useMemo(() => modelsData ?? [], [modelsData]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Surface SWR fetch errors as the status message.
  useEffect(() => {
    if (modelsError) setStatusMessage(`Could not load models: ${String(modelsError)}`);
  }, [modelsError]);

  // Listen for setModel acknowledgements
  useEffect(() => {
    const socket = getSocket();
    const onModelChanged = (data: {
      sessionId: string;
      model: { id: string; name: string; provider: string };
    }) => {
      if (data.sessionId !== sessionId) return;
      setCurrentModel(data.model);
      setBusyKey(null);
      setStatusMessage(`Model set to ${data.model.name}`);
      setTimeout(() => setStatusMessage(null), 2500);
    };
    const onThinkingChanged = (data: { sessionId: string; level: string }) => {
      if (data.sessionId !== sessionId) return;
      setThinkingLevel(data.level);
      setBusyKey(null);
      setStatusMessage(`Thinking level: ${data.level}`);
      setTimeout(() => setStatusMessage(null), 2500);
    };
    const onError = (data: { error: string }) => {
      setBusyKey(null);
      setStatusMessage(`Error: ${data.error}`);
    };
    socket.on("session:modelChanged", onModelChanged);
    socket.on("session:thinkingLevelChanged", onThinkingChanged);
    socket.on("session:error", onError);
    return () => {
      socket.off("session:modelChanged", onModelChanged);
      socket.off("session:thinkingLevelChanged", onThinkingChanged);
      socket.off("session:error", onError);
    };
  }, [sessionId, setCurrentModel, setThinkingLevel]);

  // Sort models: last-used first, then best tier, then newest.
  const sortedModels = useMemo(
    () => sortModels(models, currentModel?.id),
    [models, currentModel?.id],
  );

  function handleModelChange(model: Model) {
    setBusyKey(`model:${model.id}`);
    getSocket().emit("session:setModel", {
      sessionId,
      provider: model.provider,
      modelId: model.id,
    });
  }

  function handleThinkingLevelChange(level: string) {
    setBusyKey(`thinking:${level}`);
    getSocket().emit("session:setThinkingLevel", { sessionId, level });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="max-w-4xl mx-auto p-8">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <SettingsIcon className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          </div>
          <p className="text-muted-foreground">Configure your coding assistant preferences</p>
          {statusMessage && (
            <div className="mt-3 text-sm px-3 py-2 rounded bg-muted/50 border border-border">
              {statusMessage}
            </div>
          )}
        </div>

        <div className="space-y-6">
          {/* Appearance */}
          <section className="bg-card border border-border rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Palette className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold text-card-foreground">Appearance</h2>
            </div>
            <div>
              {/* Section sub-heading, not a form label — the buttons below set
                  the theme. Using <div> keeps the same visuals without misusing
                  <label> (which jsx-a11y flags for missing htmlFor/control). */}
              <div className="block text-sm font-medium text-card-foreground mb-2">Theme</div>
              <div className="grid grid-cols-2 gap-2 max-w-md" aria-label="Theme">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    aria-pressed={theme === opt.value}
                    onClick={() => setTheme(opt.value)}
                    className={`px-4 py-2 text-sm rounded-md border transition-colors text-left ${
                      theme === opt.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-accent"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                Tokyo is the original colorful palette; shadcn is the monochrome zinc look from
                ui.shadcn.com. All four meet WCAG 2.2 AAA contrast.
              </p>
            </div>

            {/* Mono font */}
            <div className="mt-6 pt-6 border-t border-border">
              <div className="flex items-center gap-2 mb-2">
                <Type className="w-4 h-4 text-primary" />
                {/* Section sub-heading, not a form label. */}
                <div className="block text-sm font-medium text-card-foreground">Font</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {FONT_CHOICES.map((f) => {
                  const isSelected = font === f.id;
                  return (
                    <label
                      key={f.id}
                      className={`flex items-center gap-3 p-3 border rounded-md cursor-pointer transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="font"
                        value={f.id}
                        aria-label={f.label}
                        checked={isSelected}
                        onChange={() => setFont(f.id)}
                        className="w-4 h-4"
                      />
                      <div className="flex-1 min-w-0">
                        <div
                          className="font-medium text-card-foreground"
                          style={{
                            fontFamily: f.id === "jetbrains" ? "JetBrains Mono" : "Miosevka",
                          }}
                        >
                          {f.label}
                        </div>
                        <div className="text-sm text-muted-foreground">{f.description}</div>
                      </div>
                      {isSelected && <CheckCircle2 className="w-5 h-5 text-primary" />}
                    </label>
                  );
                })}
              </div>
              <p
                className="text-sm text-muted-foreground mt-3"
                style={{ fontFamily: font === "jetbrains" ? "JetBrains Mono" : "Miosevka" }}
              >
                Preview: const greet = (x) =&gt; x != 0 ? x &gt;= 1 : 0; // 0123456789
              </p>
            </div>
          </section>

          {/* AI Model */}
          <section className="bg-card border border-border rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Brain className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold text-card-foreground">AI Model</h2>
              {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>
            <div>
              {models.length > 0 ? (
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-2">
                  {sortedModels.map((model) => {
                    const isSelected = currentModel?.id === model.id;
                    const isBusy = busyKey === `model:${model.id}`;
                    const badges = getBadges(model, models, currentModel?.id);
                    return (
                      <label
                        key={`${model.provider}:${model.id}`}
                        className="flex items-center gap-3 p-3 border border-border rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                      >
                        <input
                          type="radio"
                          name="model"
                          value={model.id}
                          aria-label={model.name}
                          checked={isSelected}
                          onChange={() => handleModelChange(model)}
                          className="w-4 h-4"
                          disabled={isBusy}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-medium text-card-foreground">{model.name}</div>
                            {badges.map((b) => (
                              <ModelBadgePill key={b} kind={b} />
                            ))}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {model.provider}
                            {model.contextWindow
                              ? ` · ${Math.round(model.contextWindow / 1000)}K context`
                              : ""}
                            {model.reasoning ? " · Reasoning" : ""}
                          </div>
                        </div>
                        {isBusy && (
                          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                        )}
                        {isSelected && !isBusy && <CheckCircle2 className="w-5 h-5 text-primary" />}
                      </label>
                    );
                  })}
                </div>
              ) : !loading ? (
                <p className="text-muted-foreground text-sm">
                  No models available. Check your API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
                  or run <code>pi /login</code> to authenticate.
                </p>
              ) : null}
            </div>
          </section>

          {/* Thinking Level */}
          <section className="bg-card border border-border rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Cpu className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold text-card-foreground">Thinking Level</h2>
            </div>
            <div className="space-y-2">
              {(["off", "minimal", "low", "medium", "high"] as const).map((level) => {
                const isBusy = busyKey === `thinking:${level}`;
                return (
                  <label
                    key={level}
                    className="flex items-center gap-3 p-3 border border-border rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                  >
                    <input
                      type="radio"
                      name="thinking"
                      value={level}
                      aria-label={`Thinking level: ${level}`}
                      checked={thinkingLevel === level}
                      onChange={() => handleThinkingLevelChange(level)}
                      className="w-4 h-4"
                      disabled={isBusy}
                    />
                    <div className="flex-1">
                      <div className="font-medium text-card-foreground capitalize">{level}</div>
                      <div className="text-sm text-muted-foreground">
                        {level === "off" && "No extended thinking"}
                        {level === "minimal" && "Minimal reasoning"}
                        {level === "low" && "Quick responses"}
                        {level === "medium" && "Balanced reasoning"}
                        {level === "high" && "Deep analysis"}
                      </div>
                    </div>
                    {isBusy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                    {thinkingLevel === level && !isBusy && (
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                    )}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Only some models support extended thinking. If you see "thinking blocks cannot be
              modified" errors, set this to <code>off</code> or start a new chat.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
