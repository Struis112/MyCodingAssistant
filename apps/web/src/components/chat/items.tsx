"use client";

import { memo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import type { ChatItem, ContentBlock } from "@/lib/store";
import { cn, formatTimestamp } from "@/lib/utils";
import type { MessageFilters } from "./types";
import { DiffViewer } from "./DiffViewer";
import { highlightImportant } from "./highlight";
import {
  accentClasses,
  ASSISTANT_BLOCK_STYLES,
  getToolStyle,
  ITEM_STYLES,
  TOOL_STATUS_STYLES,
} from "./styles";
import {
  firstArg,
  formatResult,
  getToolDiff,
  getToolPatch,
  middleEllipsis,
  safeStringify,
  toolFilePath,
} from "./utils";

/**
 * Reusable role pill ("You", "Assistant", "Tool", "System"). Pulls colour
 * and icon from ITEM_STYLES so a single edit there re-themes every item.
 */
function RoleBadge({
  kind,
  streamingHint,
}: {
  kind: keyof typeof ITEM_STYLES;
  /** Optional inline hint shown next to the timestamp (e.g. 'thinking…'). */
  streamingHint?: React.ReactNode;
}) {
  const style = ITEM_STYLES[kind];
  const c = accentClasses(style.accent);
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-bold uppercase tracking-wide",
        c.bgSolid,
        c.text,
      )}
    >
      <Icon className="w-3 h-3" />
      <span>{style.label}</span>
      {streamingHint}
    </span>
  );
}

// =============================================================================
// Dispatcher
// =============================================================================

function ItemViewBase({ item, filters }: { item: ChatItem; filters: MessageFilters }) {
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
      {/* No colored rail — the RoleBadge marks the speaker. pl-3 keeps text
          aligned with assistant replies for a calm, flush conversation. */}
      <div className={cn("w-full pl-3 py-0.5 text-muted-foreground")}>
        <div className="flex items-center gap-2 mb-1">
          <RoleBadge kind="user" />
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
  const SpinnerIcon = TOOL_STATUS_STYLES.running.icon;
  return (
    <div className="flex justify-start">
      {/* No colored rail on assistant replies — the RoleBadge already marks the
          speaker, and a full-height accent stripe added visual noise down the
          left of long answers. pl-3 keeps text aligned with the other items. */}
      <div className={cn("w-full pl-3 text-foreground py-2")}>
        <div className="flex items-center gap-2 mb-1">
          <RoleBadge kind="assistant" />
          <span className="text-xs text-muted-foreground">{formatTimestamp(item.timestamp)}</span>
          {item.isStreaming && item.blocks.length === 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <SpinnerIcon className="w-3 h-3 animate-spin" />
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
  // The streaming cursor uses the same accent the assistant pill uses, so
  // a recolour of --assistant-accent re-themes the cursor for free.
  const cursorBg = accentClasses(ASSISTANT_BLOCK_STYLES.text.accent).rail.replace("border-", "bg-");
  return (
    <div className="break-words">
      {block.isStreaming ? (
        // While streaming, render PLAIN text. Parsing markdown + running
        // highlight.js language auto-detection on every token (over the whole
        // growing message) is what made long responses crawl. It formats once
        // the block finishes — completed blocks are memoized, so they parse once.
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{block.text}</div>
      ) : (
        <Markdown>{block.text}</Markdown>
      )}
      {block.isStreaming && (
        <span
          className={cn("inline-block w-[2px] h-4 align-text-bottom cursor-blink ml-0.5", cursorBg)}
        />
      )}
    </div>
  );
}

function ThinkingBlock({ block }: { block: Extract<ContentBlock, { type: "thinking" }> }) {
  // Thinking is expanded by default and stays expanded; users can still
  // collapse it manually via the toggle.
  const [open, setOpen] = useState(true);
  const style = ASSISTANT_BLOCK_STYLES.thinking;
  const Caret = style.expandIcon!;
  const Icon = style.icon!;

  return (
    <div className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 w-full py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors select-none"
      >
        <Caret
          className={cn("w-3 h-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
        />
        <Icon className={cn("w-3 h-3 shrink-0", block.isStreaming && "animate-pulse")} />
        <span>{block.isStreaming ? "Thinking…" : "Thought process"}</span>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground pb-2.5 pt-0.5 leading-relaxed">
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

  // Per-tool style (icon + accent, with optional hideName) is centralised
  // in chat/styles.ts. ToolItem just looks it up and renders.
  const toolStyle = getToolStyle(item.toolName);
  const ToolIcon = toolStyle.icon;
  const toolAccent = accentClasses(toolStyle.accent);

  const statusStyle = TOOL_STATUS_STYLES[item.status];
  const StatusIcon = statusStyle.icon;
  const statusAccent = accentClasses(statusStyle.accent);

  // File-based tools (Read/Edit/Write) expose a `path`; keep the full path but
  // surface the file name prominently so it's easy to scan the conversation.
  const filePath = toolFilePath(item.toolName, item.args);
  const isBash = item.toolName?.toLowerCase() === "bash";

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          // Flush card with a uniform neutral border — no colored left rail.
          // The tool's category is still conveyed by its colored icon below.
          "w-full bg-card border border-border rounded-lg px-3 py-2",
        )}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs w-full text-left"
        >
          <StatusIcon
            className={cn(
              "w-3 h-3 shrink-0",
              statusAccent.text,
              item.status === "running" && "animate-spin",
            )}
          />
          <ToolIcon className={cn("w-3 h-3 shrink-0", toolAccent.text)} />
          {!toolStyle.hideName && <span className="font-semibold shrink-0">{item.toolName}</span>}
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
  const c = accentClasses(ITEM_STYLES.system.accent);
  return (
    <div className="flex justify-start">
      <div className={cn("w-full border rounded-lg px-4 py-2", c.bgTint, c.border, c.text)}>
        <div className="flex items-center gap-2 mb-1">
          <RoleBadge kind="system" />
          <span className="text-xs text-muted-foreground">{formatTimestamp(item.timestamp)}</span>
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono">{item.text}</pre>
      </div>
    </div>
  );
}

// Memoized: only the message that actually changed (e.g. the streaming
// assistant item, whose object reference updates each token) re-renders —
// not the whole list. This is the big win for streaming responsiveness.
export const ItemView = memo(ItemViewBase);
