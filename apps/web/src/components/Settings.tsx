"use client";

import { useState, useEffect, useMemo } from "react";
import { useTheme } from "@/lib/theme";
import { getSocket } from "@/lib/socket";
import { useAppStore } from "@/lib/store";
import { getBadges, sortModels, type ModelBadge } from "@/lib/models";
import { useModels, type Model } from "@/hooks/useModels";
import {
  Settings as SettingsIcon,
  Palette,
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
  const { theme, toggleTheme } = useTheme();
  const { sessionId, currentModel, setCurrentModel, thinkingLevel, setThinkingLevel } =
    useAppStore();

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
              <label className="block text-sm font-medium text-card-foreground mb-2">Theme</label>
              <button
                onClick={toggleTheme}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                Switch to {theme === "dark" ? "Light" : "Dark"} Mode
              </button>
              <p className="text-sm text-muted-foreground mt-2">
                Current theme: {theme === "dark" ? "Dark" : "Light"}
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
