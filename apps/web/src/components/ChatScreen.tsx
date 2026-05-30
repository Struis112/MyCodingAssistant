"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore, type ChatItem, type ContentBlock } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { generateId, formatTimestamp, cn } from "@/lib/utils";
import { Markdown } from "@/components/Markdown";
import {
  Send,
  Square,
  Terminal,
  Wrench,
  Check,
  X,
  Loader2,
  Brain,
  ChevronRight,
  SlidersHorizontal,
  Paperclip,
  FileText,
  Image as ImageIcon,
  AlertCircle,
} from "lucide-react";
import {
  composeMessageWithAttachments,
  formatBytes,
  makePendingFile,
  toSdkImages,
  type PendingFile,
} from "@/lib/files";

// ----- helpers to translate persisted AgentMessage[] into ChatItem[] -----

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as RawContentBlock).type === "text")
      .map((c) => (c as RawContentBlock).text || "")
      .join("");
  }
  return "";
}

function agentMessagesToChatItems(messages: RawMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of messages || []) {
    const ts = msg.timestamp || Date.now();
    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) items.push({ kind: "user", id: generateId(), text, timestamp: ts });
    } else if (msg.role === "assistant") {
      const blocks: ContentBlock[] = [];
      const content = Array.isArray(msg.content) ? (msg.content as RawContentBlock[]) : [];
      for (const c of content) {
        if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
        else if (c.type === "thinking" && c.thinking)
          blocks.push({ type: "thinking", text: c.thinking });
        else if (c.type === "toolCall" && c.id && c.name) {
          items.push({
            kind: "tool",
            id: generateId(),
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            status: "success",
            timestamp: ts,
          });
        }
      }
      if (blocks.length > 0) {
        items.push({
          kind: "assistant",
          id: generateId(),
          blocks,
          timestamp: ts,
          isStreaming: false,
        });
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const target = items.find((it) => it.kind === "tool" && it.toolCallId === msg.toolCallId);
      if (target && target.kind === "tool") {
        target.result = msg.content;
        target.isError = !!msg.isError;
        target.status = msg.isError ? "error" : "success";
      }
    }
  }
  return items;
}

// ----- main component -----

export function ChatScreen() {
  const {
    items,
    addItem,
    updateItem,
    findToolItemByCallId,
    clearItems,
    setItems,
    isStreaming,
    setIsStreaming,
    sessionId,
    sessionFile,
    setSessionFile,
    currentModel,
    thinkingLevel,
  } = useAppStore();

  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [filters, setFilters] = useState<MessageFilters>({
    assistant: true,
    thinking: true,
    tool: true,
    system: true,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentAssistantIdRef = useRef<string | null>(null);
  const dragCounterRef = useRef(0);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  // ----- SDK event handler -----

  useEffect(() => {
    const socket = getSocket();

    const onEvent = (data: { sessionId: string; event: any }) => {
      if (data.sessionId !== sessionId) return;
      const ev = data.event;
      if (!ev || typeof ev !== "object") return;

      // ---- assistant message lifecycle ----
      if (ev.type === "message_start" && ev.message?.role === "assistant") {
        const id = generateId();
        currentAssistantIdRef.current = id;
        addItem({
          kind: "assistant",
          id,
          blocks: [],
          timestamp: Date.now(),
          isStreaming: true,
        });
        return;
      }

      if (ev.type === "message_update") {
        const sub = ev.assistantMessageEvent;
        const currentId = currentAssistantIdRef.current;
        if (!sub || !currentId) return;

        const appendToLastBlock = (blockType: "text" | "thinking", delta: string) => {
          updateItem(currentId, (it) => {
            if (it.kind !== "assistant") return it;
            const blocks = [...it.blocks];
            let idx = -1;
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i].type === blockType) {
                idx = i;
                break;
              }
            }
            if (idx === -1) {
              blocks.push({ type: blockType, text: delta, isStreaming: true });
            } else {
              const b = blocks[idx] as {
                type: typeof blockType;
                text: string;
                isStreaming?: boolean;
              };
              blocks[idx] = { type: blockType, text: b.text + delta, isStreaming: true };
            }
            return { ...it, blocks };
          });
        };

        const finishBlock = (blockType: "text" | "thinking") => {
          updateItem(currentId, (it) => {
            if (it.kind !== "assistant") return it;
            const blocks = it.blocks.map((b) =>
              b.type === blockType && b.isStreaming ? { ...b, isStreaming: false } : b,
            );
            return { ...it, blocks };
          });
        };

        switch (sub.type) {
          case "text_start":
            updateItem(currentId, (it) =>
              it.kind === "assistant"
                ? { ...it, blocks: [...it.blocks, { type: "text", text: "", isStreaming: true }] }
                : it,
            );
            return;
          case "text_delta":
            appendToLastBlock("text", sub.delta || "");
            return;
          case "text_end":
            finishBlock("text");
            return;
          case "thinking_start":
            updateItem(currentId, (it) =>
              it.kind === "assistant"
                ? {
                    ...it,
                    blocks: [...it.blocks, { type: "thinking", text: "", isStreaming: true }],
                  }
                : it,
            );
            return;
          case "thinking_delta":
            appendToLastBlock("thinking", sub.delta || "");
            return;
          case "thinking_end":
            finishBlock("thinking");
            return;
        }
        return;
      }

      if (ev.type === "message_end") {
        const currentId = currentAssistantIdRef.current;
        if (currentId) {
          updateItem(currentId, (it) =>
            it.kind === "assistant" ? { ...it, isStreaming: false } : it,
          );
        }
        currentAssistantIdRef.current = null;
        return;
      }

      // ---- tool execution lifecycle ----
      if (ev.type === "tool_execution_start") {
        if (findToolItemByCallId(ev.toolCallId)) return;
        addItem({
          kind: "tool",
          id: generateId(),
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args,
          status: "running",
          timestamp: Date.now(),
        });
        return;
      }

      if (ev.type === "tool_execution_update") {
        const existing = findToolItemByCallId(ev.toolCallId);
        if (!existing || existing.kind !== "tool") return;
        updateItem(existing.id, (it) =>
          it.kind === "tool" ? { ...it, result: ev.partialResult } : it,
        );
        return;
      }

      if (ev.type === "tool_execution_end") {
        const existing = findToolItemByCallId(ev.toolCallId);
        if (!existing || existing.kind !== "tool") return;
        updateItem(existing.id, (it) =>
          it.kind === "tool"
            ? {
                ...it,
                result: ev.result,
                isError: !!ev.isError,
                status: ev.isError ? "error" : "success",
              }
            : it,
        );
        return;
      }
    };

    const onDone = (data: { sessionId: string }) => {
      if (data.sessionId !== sessionId) return;
      setIsStreaming(false);
      // Defensive: any lingering streaming blocks get finalized
      const current = currentAssistantIdRef.current;
      if (current) {
        updateItem(current, (it) => (it.kind === "assistant" ? { ...it, isStreaming: false } : it));
        currentAssistantIdRef.current = null;
      }
    };

    const onError = (data: { sessionId: string; error: string }) => {
      if (data.sessionId !== sessionId) return;
      addItem({
        kind: "system",
        id: generateId(),
        text: `Error: ${data.error}`,
        timestamp: Date.now(),
      });
      setIsStreaming(false);
    };

    const onResumed = (data: {
      sessionId: string;
      sessionFile?: string;
      messages?: RawMessage[];
    }) => {
      if (data.sessionId !== sessionId) return;
      setSessionFile(data.sessionFile);
      const restored = agentMessagesToChatItems(data.messages || []);
      setItems(restored);
    };

    const onNew = (data: { sessionId: string; sessionFile?: string }) => {
      if (data.sessionId !== sessionId) return;
      setSessionFile(data.sessionFile);
      clearItems();
    };

    socket.on("chat:event", onEvent);
    socket.on("chat:done", onDone);
    socket.on("chat:error", onError);
    socket.on("chat:resumed", onResumed);
    socket.on("chat:new", onNew);

    return () => {
      socket.off("chat:event", onEvent);
      socket.off("chat:done", onDone);
      socket.off("chat:error", onError);
      socket.off("chat:resumed", onResumed);
      socket.off("chat:new", onNew);
    };
  }, [
    sessionId,
    addItem,
    updateItem,
    findToolItemByCallId,
    setIsStreaming,
    setItems,
    clearItems,
    setSessionFile,
  ]);

  // ----- actions -----

  // ----- File ingestion -----

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const processed = await Promise.all(list.map((f) => makePendingFile(f)));

      // Surface any rejections as system items so the user knows why a file
      // didn't attach.
      const rejected = processed.filter((f) => f.kind === "unsupported");
      const accepted = processed.filter((f) => f.kind !== "unsupported");
      for (const r of rejected) {
        addItem({
          kind: "system",
          id: generateId(),
          text: `Skipped attachment "${r.name}": ${r.rejection}`,
          timestamp: Date.now(),
        });
      }
      if (accepted.length > 0) {
        setPendingFiles((prev) => [...prev, ...accepted]);
      }
    },
    [addItem],
  );

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const onFilePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) addFiles(files);
      // Reset the input so the same file can be re-attached after removing.
      e.target.value = "";
    },
    [addFiles],
  );

  // Drag/drop handlers. Use a counter to avoid the flicker where entering
  // a child element fires `dragleave` on the parent.
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      dragCounterRef.current += 1;
      setIsDragging(true);
    }
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const files = e.dataTransfer.files;
      if (files && files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  // ----- Send -----

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    const messageToSend = composeMessageWithAttachments(trimmed, pendingFiles);
    const images = toSdkImages(pendingFiles);

    // Optimistically render the user message. Show a short summary of any
    // attachments so the user can see what was sent.
    const attachmentSummary = pendingFiles.length
      ? pendingFiles.map((f) => `· ${f.name} (${formatBytes(f.size)})`).join("\n")
      : "";
    const displayText = attachmentSummary
      ? `${trimmed}${trimmed ? "\n\n" : ""}📎 ${pendingFiles.length} attachment${pendingFiles.length > 1 ? "s" : ""}:\n${attachmentSummary}`
      : trimmed;

    addItem({ kind: "user", id: generateId(), text: displayText, timestamp: Date.now() });
    if (!isStreaming) setIsStreaming(true);
    getSocket().emit("chat:send", {
      sessionId,
      message: messageToSend,
      images: images.length > 0 ? images : undefined,
    });
    setInput("");
    setPendingFiles([]);
    inputRef.current?.focus();
  }, [input, pendingFiles, isStreaming, sessionId, addItem, setIsStreaming]);

  const handleAbort = useCallback(() => {
    getSocket().emit("chat:abort", { sessionId });
    setIsStreaming(false);
  }, [sessionId, setIsStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
        <h1
          className="text-sm font-semibold text-foreground truncate max-w-[280px]"
          title={sessionFile ?? "New chat"}
        >
          {sessionTitle(sessionFile)}
        </h1>

        {/* Harness: pi.dev logo.
            Locked to the pi.dev branding color (black) inside a white circle
            so it reads cleanly on both light and dark backgrounds — same
            visual treatment as a browser favicon. */}
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white text-black ring-1 ring-black/10"
          title="Harness: Pi SDK"
          aria-label="Harness: Pi SDK"
        >
          <img src="/pi-logo.svg" alt="" className="w-3 h-3" />
        </span>

        {/* Active model — between harness icon and thinking level */}
        {currentModel ? (
          <span
            className="text-xs text-muted-foreground truncate max-w-[260px]"
            title={`Model: ${currentModel.name}`}
          >
            {currentModel.name}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground italic">no model</span>
        )}

        {/* Thinking level */}
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title="Thinking level"
        >
          <Brain className="w-3.5 h-3.5" />
          <span className="capitalize">{thinkingLevel}</span>
        </span>

        <div className="flex-1" />
        {isStreaming && <span className="text-xs text-warning animate-pulse">● Streaming...</span>}
        <MessageFilterMenu filters={filters} onChange={setFilters} />
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Center the conversation in ~70% of the width (15% gutters each side). */}
        <div className="mx-auto w-[70%] space-y-3">
          {items.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Terminal className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-sm">Start a conversation with your AI assistant</p>
              <p className="text-xs mt-2">Type a message and press Enter to begin</p>
            </div>
          )}

          {items
            .filter((item) => isItemVisible(item, filters))
            .map((item) => (
              <ItemView key={item.id} item={item} filters={filters} />
            ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div
        className={cn(
          "relative border-t p-4 shrink-0 transition-colors",
          isDragging ? "border-primary bg-primary/5" : "border-border",
        )}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Drop-zone overlay */}
        {isDragging && (
          <div className="pointer-events-none absolute inset-2 rounded-lg border-2 border-dashed border-primary/60 bg-background/80 flex items-center justify-center text-sm font-medium text-primary">
            Drop files here to attach
          </div>
        )}

        {/* Pending-attachments row */}
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((f) => (
              <PendingFileChip key={f.id} file={f} onRemove={() => removeFile(f.id)} />
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={onFilePickerChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            aria-label="Attach files"
            title="Attach files (or drag files into this area)"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming
                ? "Queue a message... (Enter to steer, Shift+Enter for newline)"
                : "Type your message... (Enter to send, Shift+Enter for newline)"
            }
            className="flex-1 bg-background border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary resize-none min-h-[44px] max-h-[200px] transition-colors"
            rows={1}
            aria-label="Message input"
          />
          {isStreaming && (
            <button
              onClick={handleAbort}
              className="px-4 py-2 bg-error/20 text-error rounded-lg hover:bg-error/30 transition-colors"
              aria-label="Stop streaming"
              title="Stop the current response"
            >
              <Square className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={!input.trim() && pendingFiles.length === 0}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={isStreaming ? "Queue message" : "Send message"}
            title={
              isStreaming
                ? "Queue this message — delivered after the current assistant turn"
                : "Send message"
            }
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Item rendering =====

// ===== Message filters =====

export interface MessageFilters {
  assistant: boolean;
  thinking: boolean;
  tool: boolean;
  system: boolean;
}

const FILTER_OPTIONS: { key: keyof MessageFilters; label: string }[] = [
  { key: "assistant", label: "Assistant" },
  { key: "thinking", label: "Thinking" },
  { key: "tool", label: "Tool" },
  { key: "system", label: "System" },
];

// Decide whether a top-level item should render given the active filters.
// User messages are always shown. Assistant items stay visible if either
// their text or thinking content is enabled (block-level filtering happens
// inside AssistantItem).
function isItemVisible(item: ChatItem, filters: MessageFilters): boolean {
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

function MessageFilterMenu({
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

function ItemView({ item, filters }: { item: ChatItem; filters: MessageFilters }) {
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

function UserItem({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="flex justify-start">
      <div className="w-full border-l-2 border-primary/50 pl-3 py-0.5 text-muted-foreground">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium uppercase text-muted-foreground/70">You</span>
          <span className="text-xs text-muted-foreground/70">
            {formatTimestamp(item.timestamp)}
          </span>
        </div>
        <pre className="text-xs whitespace-pre-wrap font-mono">{item.text}</pre>
      </div>
    </div>
  );
}

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
      <div className="w-full text-foreground py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase">Assistant</span>
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

// Render plain text while turning **double-asterisk** spans into bold.
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
                return (
                  <div>
                    <div className="text-muted-foreground mb-1">diff:</div>
                    <DiffView diff={diff} />
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

// ----- attachment chip -----

function PendingFileChip({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const Icon = file.kind === "image" ? ImageIcon : file.kind === "text" ? FileText : AlertCircle;
  const tone =
    file.kind === "unsupported"
      ? "border-error/40 text-error bg-error/10"
      : "border-border text-foreground bg-muted/40";
  return (
    <span
      className={`inline-flex items-center gap-1.5 max-w-[260px] pl-2 pr-1 py-1 rounded-md border text-xs ${tone}`}
      title={`${file.name} · ${formatBytes(file.size)}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{file.name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 p-0.5 rounded hover:bg-background"
        aria-label={`Remove ${file.name}`}
        title="Remove"
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}

// ----- diff rendering -----

// The SDK's `edit` tool returns details.diff: lines prefixed with
// "+" (added), "-" (removed) or " " (unchanged/context), each followed by a
// padded line number. We colour added=green, removed=red, context=muted.
function getToolDiff(result: unknown): string | null {
  if (result && typeof result === "object") {
    const details = (result as { details?: unknown }).details;
    if (details && typeof details === "object") {
      const diff = (details as { diff?: unknown }).diff;
      if (typeof diff === "string" && diff.trim()) return diff;
    }
  }
  return null;
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="rounded border border-border font-mono text-xs leading-relaxed overflow-x-auto">
      {lines.map((line, i) => {
        const marker = line[0];
        const cls =
          marker === "+"
            ? "bg-success/10 text-success"
            : marker === "-"
              ? "bg-error/10 text-error"
              : "text-muted-foreground";
        return (
          <div key={i} className={cn("px-2 whitespace-pre", cls)}>
            {line.length ? line : " "}
          </div>
        );
      })}
    </pre>
  );
}

// ----- formatting helpers -----

// Returns the first argument as { key, value } with the value fully stringified
// (not truncated). Truncation for display happens at render time so the full
// value is always available via the title tooltip and the expanded args pane.
// For file-based tools (Read/Edit/Write), pull the `path` arg apart into its
// directory prefix and base file name so the UI can keep the full path visible
// while highlighting just the file name (e.g. "theme.tsx"). Returns null for
// tools that don't operate on a path.
function toolFilePath(
  toolName: string | undefined,
  args: unknown,
): { dir: string; base: string } | null {
  const fileTools = new Set(["read", "edit", "write"]);
  if (!toolName || !fileTools.has(toolName.toLowerCase())) return null;
  if (!args || typeof args !== "object") return null;
  const path = (args as Record<string, unknown>).path;
  if (typeof path !== "string" || !path) return null;
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0
    ? { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) || path }
    : { dir: "", base: path };
}

// Does a single whitespace-delimited token look like a file or path?
// (contains a slash, or ends in a short ".ext"). Surrounding quotes/punctuation
// are stripped first so `"foo.ts",` still matches.
function looksLikePath(token: string): boolean {
  const s = token.replace(/^["'(<]+|["',);>]+$/g, "");
  if (!s) return false;
  return /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

// Render a value string with any file/path-like tokens highlighted in a
// prominent white, and everything else in `restClass`. Returns null when the
// value contains no path-like token, so the caller can pick its own fallback.
function highlightImportant(value: string, restClass: string): React.ReactNode | null {
  if (!looksLikePath(value) && !value.split(/\s+/).some(looksLikePath)) return null;
  // Split on whitespace but keep the separators so spacing is preserved.
  return value.split(/(\s+)/).map((tok, i) =>
    /\S/.test(tok) && looksLikePath(tok) ? (
      <span key={i} className="text-foreground font-semibold">
        {tok}
      </span>
    ) : (
      <span key={i} className={restClass}>
        {tok}
      </span>
    ),
  );
}

function firstArg(args: unknown): { key: string; value: string } | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const key = Object.keys(obj)[0];
  if (!key) return null;
  const v = obj[key];
  return { key, value: typeof v === "string" ? v : safeStringify(v) };
}

// Truncate in the middle so the meaningful tail (e.g. a file name) stays
// visible: "C:/Users/…/message-preview.html".
function middleEllipsis(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - tail)}`;
}

// Derive a short, human-readable title from the persisted session file path.
// Pi SDK names sessions like `2026-05-30T20-15-12-abc123.json`; strip the
// extension and any leading timestamp prefix so the header stays readable.
function sessionTitle(sessionFile: string | undefined): string {
  if (!sessionFile) return "New chat";
  const base = sessionFile.split(/[\\/]/).pop() ?? sessionFile;
  const noExt = base.replace(/\.json$/i, "");
  // Drop ISO-ish timestamp prefix (e.g. "2026-05-30T20-15-12-") if present.
  const trimmed = noExt.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+-/, "");
  return trimmed || noExt || "Session";
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(r.content)) {
      return r.content
        .map((c) => (c.type === "text" && c.text ? c.text : safeStringify(c)))
        .join("\n");
    }
  }
  return safeStringify(result);
}
