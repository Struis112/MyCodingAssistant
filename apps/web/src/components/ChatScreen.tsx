"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, Terminal } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { Composer } from "@/components/chat/Composer";
import { ItemView } from "@/components/chat/items";
import { MessageFilterMenu, isItemVisible } from "@/components/chat/Filters";
import { useChatEvents } from "@/components/chat/useChatEvents";
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
export function ChatScreen() {
  const { items, sessionFile, sessionName, currentModel, thinkingLevel, isStreaming } =
    useAppStore();

  const [filters, setFilters] = useState<MessageFilters>({
    assistant: true,
    thinking: true,
    tool: true,
    system: true,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Subscribe to socket events. The hook handles all add/update/clear calls
  // against the store so we don't need to thread callbacks here.
  useChatEvents();

  // Auto-scroll when items change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  return (
    <div className="flex flex-col h-full bg-background">
      <ChatHeader
        sessionFile={sessionFile}
        sessionName={sessionName}
        currentModel={currentModel}
        thinkingLevel={thinkingLevel}
        isStreaming={isStreaming}
        filters={filters}
        onFiltersChange={setFilters}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
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
            {items
              .filter((item) => isItemVisible(item, filters))
              .map((item) => (
                <ItemView key={item.id} item={item} filters={filters} />
              ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <Composer />
    </div>
  );
}

function ChatHeader({
  sessionFile,
  sessionName,
  currentModel,
  thinkingLevel,
  isStreaming,
  filters,
  onFiltersChange,
}: {
  sessionFile: string | undefined;
  sessionName: string | null;
  currentModel: { id: string; name: string; provider: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  filters: MessageFilters;
  onFiltersChange: (next: MessageFilters) => void;
}) {
  return (
    <header className="h-8 border-b border-border flex items-center px-3 gap-2 shrink-0">
      <EditableTitle sessionName={sessionName} sessionFile={sessionFile} />

      {/* Harness: pi.dev logo.
          Locked to the pi.dev branding color (black) inside a white circle
          so it reads cleanly on both light and dark backgrounds — same
          visual treatment as a browser favicon. */}
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-white text-black ring-1 ring-black/10"
        title="Harness: Pi SDK"
        aria-label="Harness: Pi SDK"
      >
        <img src="/pi-logo.svg" alt="" className="w-2.5 h-2.5" />
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
        <Brain className="w-3 h-3" />
        <span className="capitalize">{thinkingLevel}</span>
      </span>

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
  const { sessionId } = useAppStore();
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
