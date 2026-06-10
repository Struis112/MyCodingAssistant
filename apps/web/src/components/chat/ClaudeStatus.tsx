"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useClaudeStatus } from "@/hooks/useClaudeStatus";
import { cn } from "@/lib/utils";

/**
 * Quiet Claude-status ticker for the header. Renders nothing unless there's a
 * status update within the last 48h (the server filters that). When the text is
 * wider than its slot it scrolls (marquee); otherwise it sits still. The slot is
 * sized by the caller (~50% of the leftover header space) and this fills it.
 */
export function ClaudeStatus({ className }: { className?: string }) {
  const { data } = useClaudeStatus();
  const incidents = data?.incidents ?? [];
  const text = incidents.map((i) => i.title).join("    •    ");

  const viewRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [durationS, setDurationS] = useState(16);

  useEffect(() => {
    const view = viewRef.current;
    const primary = primaryRef.current;
    if (!view || !primary) return;
    const check = () => {
      const w = primary.offsetWidth;
      const over = w > view.clientWidth + 1;
      setOverflow(over);
      // Constant ~40px/s scroll speed regardless of text length.
      if (over) setDurationS(Math.max(10, Math.round(w / 40)));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(view);
    ro.observe(primary);
    return () => ro.disconnect();
  }, [text]);

  if (incidents.length === 0) return null;

  return (
    <a
      href={incidents[0]?.url || "https://status.claude.com"}
      target="_blank"
      rel="noopener noreferrer"
      title={`Claude status — ${incidents.length} update${incidents.length > 1 ? "s" : ""} in the last 48h (opens status.claude.com)`}
      className={cn(
        "group flex items-center gap-1.5 h-6 px-2 rounded-md border border-warning/40 bg-warning/10 text-warning text-xs overflow-hidden hover:bg-warning/20 transition-colors",
        className,
      )}
    >
      <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden />
      <div ref={viewRef} className="relative min-w-0 flex-1 overflow-hidden">
        <div
          className={cn("inline-flex whitespace-nowrap", overflow && "cs-marquee")}
          style={overflow ? { animationDuration: `${durationS}s` } : undefined}
        >
          <span ref={primaryRef} className="pr-12">
            {text}
          </span>
          {overflow && (
            <span className="pr-12" aria-hidden>
              {text}
            </span>
          )}
        </div>
      </div>
    </a>
  );
}
