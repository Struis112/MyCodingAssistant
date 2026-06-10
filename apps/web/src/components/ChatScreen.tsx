"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Terminal } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { getSocket } from "@/lib/socket";
import { Composer } from "@/components/chat/Composer";
import { ItemView } from "@/components/chat/items";
import { MessageFilterMenu, isItemVisible } from "@/components/chat/Filters";
import { useChatEvents } from "@/components/chat/useChatEvents";
import { ChatTabs } from "@/components/chat/ChatTabs";
import { ModelPicker, EffortPicker } from "@/components/chat/HeaderControls";
import { useUsage } from "@/hooks/useUsage";
import { sessionTitle } from "@/components/chat/utils";
import type { MessageFilters } from "@/components/chat/types";

/**
 * Top-level chat screen. The heavy lifting lives in dedicated modules:
 *   - useChatEvents     — translates server-side AgentSessionEvents into ChatItems
 *   - <Composer />      — textarea, file picker, drag/drop, send/abort
 *   - <ItemView />      — per-item rendering (user / assistant / tool / system)
 *   - <MessageFilterMenu /> + isItemVisible — message-type filtering
 *
 * What stays here:
 *   - header (session title, harness icon, active model, thinking level, filters)
 *   - scrollable messages region with auto-scroll
 *   - the filters state (passed to both header menu and item visibility)
 */
// Stable empty array so the `items` selector keeps identity when a session has
// none (avoids needless re-renders under useShallow).
const EMPTY_ITEMS: never[] = [];

// Windowing: render only the most recent messages for speed on long chats;
// scrolling to the top loads older ones in batches. A small initial window
// makes opening a long conversation instant; tweak freely.
const INITIAL_WINDOW = 150;
const WINDOW_STEP = 500;

export function ChatScreen() {
  const { items, sessionFile, sessionName, isStreaming, activeSessionId } = useAppStore(
    useShallow((s) => {
      const a = s.sessions[s.activeSessionId];
      return {
        items: a?.items ?? EMPTY_ITEMS,
        sessionFile: a?.sessionFile,
        sessionName: a?.name ?? null,
        isStreaming: a?.isStreaming ?? false,
        activeSessionId: s.activeSessionId,
      };
    }),
  );

  const [filters, setFilters] = useState<MessageFilters>({
    assistant: true,
    thinking: true,
    tool: true,
    system: true,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // How many of the most-recent messages to render (windowing for speed).
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  // Captured before loading older messages so the scroll stays anchored once
  // the taller list renders.
  const pendingPrependRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  // Subscribe to socket events. The hook handles all add/update/clear calls
  // against the store so we don't need to thread callbacks here.
  useChatEvents();

  // Track whether the view is pinned to the bottom so we only auto-scroll when
  // the user hasn't scrolled up to read earlier messages.
  // Visible window: filter ONLY the last `windowSize` messages (not the whole
  // history) so this stays cheap per streaming token even on long chats.
  const visibleItems = useMemo(() => {
    const windowed = items.length > windowSize ? items.slice(-windowSize) : items;
    return windowed.filter((item) => isItemVisible(item, filters));
  }, [items, windowSize, filters]);
  const hiddenCount = Math.max(0, items.length - windowSize);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setAtBottom(near);
    // Near the top with older messages hidden → load the next batch.
    if (el.scrollTop < 120 && hiddenCount > 0 && !pendingPrependRef.current) {
      pendingPrependRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
      setWindowSize((w) => w + WINDOW_STEP);
    }
  };

  // Auto-scroll on new content ONLY when already near the bottom. Instant while
  // streaming (smooth lags behind token bursts); smooth for one-off additions.
  useEffect(() => {
    if (!atBottomRef.current) return;
    // Coalesce token-by-token scrolls into one per frame (avoids layout thrash).
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
    });
  }, [items, isStreaming]);

  const jumpToLatest = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    atBottomRef.current = true;
    setAtBottom(true);
  };

  // Switching tabs/sessions resets the window to the most recent messages.
  useEffect(() => {
    setWindowSize(INITIAL_WINDOW);
  }, [activeSessionId]);

  // After loading older messages, keep the viewport anchored (no jump to top).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = pendingPrependRef.current;
    if (el && p) {
      el.scrollTop = p.prevTop + (el.scrollHeight - p.prevHeight);
      pendingPrependRef.current = null;
    }
  }, [windowSize]);

  return (
    <div className="flex flex-col h-full bg-background">
      <ChatHeader
        sessionFile={sessionFile}
        sessionName={sessionName}
        isStreaming={isStreaming}
        filters={filters}
        onFiltersChange={setFilters}
      />
      <ChatTabs />

      {/* Messages */}
      <div className="relative flex-1 flex flex-col overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            // Empty state: full-width + full-height so items-center/justify-center
            // actually centers in both axes. Kept outside the 70% column wrapper
            // because that wrapper is content-height (no slack to vertically
            // center within).
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Terminal className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-sm">Start a conversation with your AI assistant</p>
              <p className="text-xs mt-2">Type a message and press Enter to begin</p>
            </div>
          ) : (
            /* Center the conversation in the shared chat column (see .chat-column). */
            <div className="chat-column space-y-3">
              {hiddenCount > 0 && (
                <div className="text-center py-2 text-xs text-muted-foreground select-none">
                  Showing the latest {visibleItems.length} messages · scroll up to load{" "}
                  {Math.min(WINDOW_STEP, hiddenCount)} older
                </div>
              )}
              {visibleItems.map((item) => (
                <ItemView key={item.id} item={item} filters={filters} />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      <Composer atBottom={atBottom} onScrollToBottom={jumpToLatest} />
    </div>
  );
}

/** Anthropic usage: 5-hour + weekly windows, e.g. "5h 8% / W 2%". */
function UsageIndicator() {
  const { data } = useUsage();
  // SWR's cache is localStorage-backed (see swr-provider.tsx), so on the client
  // `data` is already populated on the very first render while the server had
  // none — that divergence is a hydration mismatch. Render the same placeholder
  // the server did until after mount, then show the real (client-only) values.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const fmt = (v: number | null | undefined) => (!mounted || v == null ? "—" : `${v}%`);

  // Reset-times tooltip (client-only, like the values themselves).
  const fmtTime = (ms?: number) =>
    ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const fmtWhen = (ms?: number) =>
    ms
      ? new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : null;
  const parts: string[] = [];
  if (mounted) {
    const fiveReset = fmtTime(data?.resetsAt?.fiveHourMs);
    const weekReset = fmtWhen(data?.resetsAt?.weeklyMs);
    if (fiveReset) parts.push(`5h window resets ${fiveReset}`);
    if (weekReset) parts.push(`weekly resets ${weekReset}`);
  }
  const title = parts.length
    ? parts.join(" · ")
    : "Anthropic usage limits — rolling 5-hour and weekly windows";

  return (
    <span className="text-xs text-muted-foreground tabular-nums" title={title}>
      5h {fmt(data?.fiveHourPct)} / W {fmt(data?.weeklyPct)}
    </span>
  );
}

function ChatHeader({
  sessionFile,
  sessionName,
  isStreaming,
  filters,
  onFiltersChange,
}: {
  sessionFile: string | undefined;
  sessionName: string | null;
  isStreaming: boolean;
  filters: MessageFilters;
  onFiltersChange: (next: MessageFilters) => void;
}) {
  return (
    <header className="h-8 border-b border-border flex items-center px-3 gap-2 shrink-0">
      <EditableTitle sessionName={sessionName} sessionFile={sessionFile} />

      {/* Harness: pi.dev logo — black glyph inside a white circle so it reads
          cleanly on both light and dark backgrounds. The white fill is set via
          inline style so a theme's `bg-white` override can't drop it. */}
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-black ring-1 ring-black/10 shrink-0"
        style={{ backgroundColor: "#ffffff" }}
        title="Harness: Pi SDK"
        aria-label="Harness: Pi SDK"
      >
        <Image src="/pi-logo.svg" alt="" width={10} height={10} className="w-2.5 h-2.5" />
      </span>

      {/* Anthropic usage limits (5-hour + weekly) — right after the logo */}
      <UsageIndicator />

      {/* Model + effort — click to change (like Settings). */}
      <div className="flex items-center gap-2 ml-3 min-w-0">
        <ModelPicker />
        <EffortPicker />
      </div>

      <div className="flex-1" />
      {isStreaming && <span className="text-xs text-warning animate-pulse">● Streaming...</span>}
      <MessageFilterMenu filters={filters} onChange={onFiltersChange} />
    </header>
  );
}

/**
 * Click-to-edit session title. Clicking the heading swaps it for an inline
 * text input; Enter (or blur) commits via the same `session:setName` event
 * used by the `/name` slash command, Escape cancels. The store's
 * `session:nameChanged` handler updates the displayed name, so we don't set it
 * locally here.
 */
function EditableTitle({
  sessionName,
  sessionFile,
}: {
  sessionName: string | null;
  sessionFile: string | undefined;
}) {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayed = sessionName ?? sessionTitle(sessionFile);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(sessionName ?? "");
    setEditing(true);
  };

  const commit = () => {
    const name = draft.trim();
    setEditing(false);
    if (name && name !== sessionName) {
      getSocket().emit("session:setName", { sessionId, name });
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        placeholder="Session name"
        aria-label="Session name"
        className="text-xs font-semibold text-foreground bg-transparent border border-border rounded px-1 py-0.5 max-w-[280px] outline-none focus:ring-1 focus:ring-ring"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      title="Click to rename this chat"
      className="text-xs font-semibold text-foreground truncate max-w-[280px] hover:text-primary text-left"
    >
      {displayed}
    </button>
  );
}
