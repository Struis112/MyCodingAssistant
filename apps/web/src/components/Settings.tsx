"use client";

import { useState, useEffect } from "react";
import { useTheme } from "@/lib/theme";
import { getSocket } from "@/lib/socket";
import { useAppStore } from "@/lib/store";
import { Settings as SettingsIcon, Palette, Brain, Cpu, CheckCircle2, Loader2 } from "lucide-react";

interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001";

export function Settings() {
  const { theme, toggleTheme } = useTheme();
  const { sessionId, currentModel, setCurrentModel } = useAppStore();
  const [models, setModels] = useState<Model[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState<string>("off");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Fetch available models on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const r = await fetch(`${SERVER_URL}/api/models`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Model[];
        if (cancelled) return;
        setModels(data);
        if (!currentModel && data.length > 0) {
          // Don't set on the server, just hint the UI selection
        }
      } catch (err) {
        if (!cancelled) setStatusMessage(`Could not load models: ${String(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentModel]);

  // Listen for setModel acknowledgements
  useEffect(() => {
    const socket = getSocket();
    const onModelChanged = (data: { sessionId: string; model: { id: string; name: string; provider: string } }) => {
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
  }, [sessionId, setCurrentModel]);

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
            <div className="mt-3 text-sm px-3 py-2 rounded bg-muted/50 border border-border">{statusMessage}</div>
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
                Current theme: {theme === "dark" ? "Dark" : "Light"} (WCAG AAA compliant)
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
                  {models.map((model) => {
                    const isSelected = currentModel?.id === model.id;
                    const isBusy = busyKey === `model:${model.id}`;
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
                        <div className="flex-1">
                          <div className="font-medium text-card-foreground">{model.name}</div>
                          <div className="text-sm text-muted-foreground">
                            {model.provider}
                            {model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}K context` : ""}
                            {model.reasoning ? " · Reasoning" : ""}
                          </div>
                        </div>
                        {isBusy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                        {isSelected && !isBusy && <CheckCircle2 className="w-5 h-5 text-primary" />}
                      </label>
                    );
                  })}
                </div>
              ) : !loading ? (
                <p className="text-muted-foreground text-sm">
                  No models available. Check your API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) or run{" "}
                  <code>pi /login</code> to authenticate.
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
                    {thinkingLevel === level && !isBusy && <CheckCircle2 className="w-5 h-5 text-primary" />}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Only some models support extended thinking. If you see "thinking blocks cannot be modified" errors, set
              this to <code>off</code> or start a new chat.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
