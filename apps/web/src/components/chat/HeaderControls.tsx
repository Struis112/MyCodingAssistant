"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { useModels } from "@/hooks/useModels";
import { sortModels } from "@/lib/models";
import { cn } from "@/lib/utils";

/** Close a popover when clicking/tabbing outside of it. */
function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
}

/** Click the model name to switch models for the active session (like Settings). */
export function ModelPicker() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const currentModel = useAppStore((s) => s.currentModel);
  const setCurrentModel = useAppStore((s) => s.setCurrentModel);
  const { data } = useModels();
  const models = useMemo(() => sortModels(data ?? [], currentModel?.id), [data, currentModel?.id]);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  const select = (m: { id: string; name: string; provider: string }) => {
    setCurrentModel({ id: m.id, name: m.name, provider: m.provider }); // optimistic
    getSocket().emit("session:setModel", { sessionId, provider: m.provider, modelId: m.id });
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors max-w-[240px]"
        title="Change model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{currentModel?.name ?? "no model"}</span>
        <ChevronDown className="w-3 h-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 max-h-80 overflow-y-auto rounded-md border border-border bg-card py-1 text-xs shadow-lg">
          {models.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">No models available</div>
          ) : (
            models.map((m) => {
              const selected = currentModel?.id === m.id;
              return (
                <button
                  key={`${m.provider}:${m.id}`}
                  type="button"
                  onClick={() => select(m)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50",
                    selected && "text-primary",
                  )}
                >
                  <Check
                    className={cn("w-3 h-3 shrink-0", selected ? "opacity-100" : "opacity-0")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{m.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {m.provider}
                      {m.reasoning ? " · reasoning" : ""}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

const LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

/** Click the thinking level to change it for the active session. */
export function EffortPicker() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const thinkingLevel = useAppStore((s) => s.thinkingLevel);
  const setThinkingLevel = useAppStore((s) => s.setThinkingLevel);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  const select = (level: string) => {
    setThinkingLevel(level); // optimistic
    getSocket().emit("session:setThinkingLevel", { sessionId, level });
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        title="Change thinking level"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Brain className="w-3 h-3" />
        <span className="capitalize">{thinkingLevel}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-36 rounded-md border border-border bg-card py-1 text-xs shadow-lg">
          {LEVELS.map((level) => {
            const selected = thinkingLevel === level;
            return (
              <button
                key={level}
                type="button"
                onClick={() => select(level)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left capitalize hover:bg-accent/50",
                  selected && "text-primary",
                )}
              >
                <Check className={cn("w-3 h-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                {level}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
