"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ChatItem } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { MessageFilters } from "./types";

export const FILTER_OPTIONS: { key: keyof MessageFilters; label: string }[] = [
  { key: "assistant", label: "Assistant" },
  { key: "thinking", label: "Thinking" },
  { key: "tool", label: "Tool" },
  { key: "system", label: "System" },
];

/**
 * Decide whether a top-level item should render given the active filters.
 * User messages are always shown. Assistant items stay visible if either
 * their text or thinking content is enabled (block-level filtering happens
 * inside AssistantItem).
 */
export function isItemVisible(item: ChatItem, filters: MessageFilters): boolean {
  switch (item.kind) {
    case "user":
      return true;
    case "tool":
      return filters.tool;
    case "system":
      return filters.system;
    case "assistant": {
      const hasThinking = item.blocks.some((b) => b.type === "thinking");
      const hasText = item.blocks.some((b) => b.type === "text");
      if (item.blocks.length === 0) return filters.assistant; // streaming placeholder
      return (filters.assistant && hasText) || (filters.thinking && hasThinking);
    }
  }
}

/**
 * Header chip + dropdown menu for toggling which item types render. Closes
 * on outside click and on Escape.
 */
export function MessageFilterMenu({
  filters,
  onChange,
}: {
  filters: MessageFilters;
  onChange: (next: MessageFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const hiddenCount = FILTER_OPTIONS.filter((o) => !filters[o.key]).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-colors",
          hiddenCount > 0
            ? "border-primary/50 text-primary"
            : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40",
        )}
        title="Filter messages"
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        <span>Filters</span>
        {hiddenCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
            {hiddenCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-20 w-44 rounded-md border border-border bg-card shadow-lg py-1"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            Show message types
          </div>
          {FILTER_OPTIONS.map((opt) => (
            <label
              key={opt.key}
              className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-accent transition-colors"
            >
              <input
                type="checkbox"
                checked={filters[opt.key]}
                onChange={(e) => onChange({ ...filters, [opt.key]: e.target.checked })}
                className="accent-primary w-3.5 h-3.5"
              />
              <span className="text-foreground">{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
