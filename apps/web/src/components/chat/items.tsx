"use client";

import { useState } from "react";
import { Brain, Check, ChevronRight, Loader2, Wrench, X } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import type { ChatItem, ContentBlock } from "@/lib/store";
import { cn, formatTimestamp } from "@/lib/utils";
import type { MessageFilters } from "./types";
import { DiffViewer } from "./DiffViewer";
import { highlightImportant } from "./highlight";
import {
  firstArg,
  formatResult,
  getToolDiff,
  getToolPatch,
  middleEllipsis,
  safeStringify,
  toolFilePath,
} from "./utils";

// =============================================================================
// Dispatcher
// =============================================================================

export function ItemView({ item, filters }: { item: ChatItem; filters: MessageFilters }) {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} />;
    case "assistant":
      return <AssistantItem item={item} filters={filters} />;
    case "tool":
      return <ToolItem item={item} />;
    case "system":
      return <SystemItem item={item} />;
  }
}

// =============================================================================
// User
// =============================================================================

function UserItem({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="flex justify-start">
      <div className="w-full border-l-2 border-primary pl-3 py-0.5 text-muted-foreground">
        <div className="flex items-center gap-2 mb-1">
          <span className="rounded-full bg-primary/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-primary">
            You
          </span>
          <span className="text-xs text-muted-foreground/70">
            {formatTimestamp(item.timestamp)}
          </span>
        </div>
        <pre className="text-xs whitespace-pre-wrap font-mono">{item.text}</pre>
      </div>
    </div>
  );
}

// =============================================================================
// Assistant (with text + thinking blocks)
// =============================================================================

function AssistantItem({
  item,
  filters,
}: {
  item: Extract<ChatItem, { kind: "assistant" }>;
  filters: MessageFilters;
}) {
  // Block-level filtering: "Assistant" controls text blocks, "Thinking" controls reasoning.
  const visibleBlocks = item.blocks.filter((b) =>
    b.type === "thinking" ? filters.thinking : filters.assistant,
  );
  return (
    <div className="flex justify-start">
      <div className="w-full border-l-2 border-success/60 pl-3 text-foreground py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="rounded-full bg-success/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-success">
            Assistant
          </span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(item.timestamp)}</span>
          {item.isStreaming && item.blocks.length === 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              thinking…
            </span>
          )}
        </div>
        <div className="space-y-2">
          {visibleBlocks.map((block, i) =>
            block.type === "thinking" ? (
              <ThinkingBlock key={i} block={block} />
            ) : (
              <TextBlock key={i} block={block} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function TextBlock({ block }: { block: Extract<ContentBlock, { type: "text" }> }) {
  return (
    <div className="break-words">
      <Markdown>{block.text}</Markdown>
      {block.isStreaming && (
        <span className="inline-block w-[2px] h-4 align-text-bottom bg-primary cursor-blink ml-0.5" />
      )}
    </div>
  );
}

function ThinkingBlock({ block }: { block: Extract<ContentBlock, { type: "thinking" }> }) {
  // Thinking is expanded by default and stays expanded; users can still
  // collapse it manually via the toggle.
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-md border border-border/70 bg-accent/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors select-none"
      >
        <ChevronRight
          className={cn("w-3 h-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
        />
        <Brain className={cn("w-3 h-3 shrink-0", block.isStreaming && "animate-pulse")} />
        <span>{block.isStreaming ? "Thinking…" : "Thought process"}</span>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground px-3 pb-2.5 pt-0.5 ml-2 border-l-2 border-border/60 leading-relaxed">
          {block.text}
          {block.isStreaming && (
            <span className="inline-block w-[2px] h-3 align-text-bottom bg-muted-foreground cursor-blink ml-0.5" />
          )}
        </pre>
      )}
    </div>
  );
}

// =============================================================================
// Tool execution
// =============================================================================

function ToolItem({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(item.status === "error");

  // Bash commands get a cleaner treatment: no wrench icon, no "Bash" label —
  // just the command itself.
  const isBash = item.toolName?.toLowerCase() === "bash";
  // File-based tools (Read/Edit/Write) expose a `path`; keep the full path but
  // surface the file name prominently so it's easy to scan the conversation.
  const filePath = toolFilePath(item.toolName, item.args);

  return (
    <div className="flex justify-start">
      <div className="w-full bg-card border border-border rounded-lg px-3 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs w-full text-left"
        >
          {item.status === "running" && (
            <Loader2 className="w-3 h-3 animate-spin text-warning shrink-0" />
          )}
          {item.status === "success" && <Check className="w-3 h-3 text-success shrink-0" />}
          {item.status === "error" && <X className="w-3 h-3 text-error shrink-0" />}
          {!isBash && !filePath && <Wrench className="w-3 h-3 text-primary shrink-0" />}
          {!isBash && <span className="font-semibold shrink-0">{item.toolName}</span>}
          {(() => {
            const fa = firstArg(item.args);
            if (!fa) return null;
            const full = `${fa.key}: ${fa.value}`;
            // Keep the full path visible but highlight just the file-name
            // segment in a prominent white (e.g. dim "src/components/" + white
            // "theme.tsx"). The directory is middle-ellipsized so the white
            // file name stays visible even for deep paths.
            if (filePath) {
              return (
                <span className="truncate" title={fa.value}>
                  {filePath.dir && (
                    <span className="text-muted-foreground">
                      {middleEllipsis(filePath.dir, 48)}
                    </span>
                  )}
                  <span className="text-foreground font-semibold">{filePath.base}</span>
                </span>
              );
            }
            // Bash: show just the command, no "command:" key prefix. Highlight
            // any file/path inside it in white and dim the rest; if there's no
            // path-like token, the whole command is the important part (white).
            if (isBash) {
              const highlighted = highlightImportant(fa.value, "text-muted-foreground");
              return (
                <span className="truncate font-mono" title={full}>
                  {highlighted ?? (
                    <span className="text-foreground font-semibold">
                      {middleEllipsis(fa.value)}
                    </span>
                  )}
                </span>
              );
            }
            // Other tools: dim the key. Highlight a file/path inside the value
            // in white; otherwise the whole value is the argument, shown orange.
            {
              const highlighted = highlightImportant(fa.value, "text-arg");
              return (
                <span className="truncate" title={full}>
                  <span className="text-muted-foreground">{fa.key}: </span>
                  {highlighted ?? <span className="text-arg">{middleEllipsis(fa.value)}</span>}
                </span>
              );
            }
          })()}
        </button>
        {expanded && (
          <div className="mt-2 text-xs space-y-2">
            <div>
              <div className="text-muted-foreground mb-1">args:</div>
              <pre className="bg-muted/30 p-2 rounded font-mono whitespace-pre-wrap text-xs overflow-x-auto">
                {safeStringify(item.args)}
              </pre>
            </div>
            {(() => {
              const diff = getToolDiff(item.result);
              if (diff && !item.isError) {
                const patch = getToolPatch(item.result) ?? undefined;
                const rawPath =
                  item.args && typeof item.args === "object"
                    ? (item.args as Record<string, unknown>).path
                    : undefined;
                const path = typeof rawPath === "string" ? rawPath : undefined;
                return (
                  <div>
                    <div className="text-muted-foreground mb-1">diff:</div>
                    <DiffViewer
                      diff={diff}
                      fileName={filePath?.base}
                      filePath={path}
                      patch={patch}
                    />
                  </div>
                );
              }
              if (item.result === undefined) return null;
              return (
                <div>
                  <div className="text-muted-foreground mb-1">result:</div>
                  <pre
                    className={cn(
                      "p-2 rounded font-mono whitespace-pre-wrap text-xs overflow-x-auto",
                      item.isError ? "bg-error/10 text-error" : "bg-muted/30",
                    )}
                  >
                    {formatResult(item.result)}
                  </pre>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// System
// =============================================================================

function SystemItem({ item }: { item: Extract<ChatItem, { kind: "system" }> }) {
  return (
    <div className="flex justify-start">
      <div className="w-full bg-warning/10 border border-warning/30 text-warning rounded-lg px-4 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase">System</span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(item.timestamp)}</span>
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono">{item.text}</pre>
      </div>
    </div>
  );
}
