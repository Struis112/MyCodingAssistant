"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, Terminal } from "lucide-react";
import { useAppStore } from "@/lib/store";
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
  const { items, sessionFile, currentModel, thinkingLevel, isStreaming } = useAppStore();

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
        currentModel={currentModel}
        thinkingLevel={thinkingLevel}
        isStreaming={isStreaming}
        filters={filters}
        onFiltersChange={setFilters}
      />

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

      <Composer />
    </div>
  );
}

function ChatHeader({
  sessionFile,
  currentModel,
  thinkingLevel,
  isStreaming,
  filters,
  onFiltersChange,
}: {
  sessionFile: string | undefined;
  currentModel: { id: string; name: string; provider: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  filters: MessageFilters;
  onFiltersChange: (next: MessageFilters) => void;
}) {
  return (
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
      <MessageFilterMenu filters={filters} onChange={onFiltersChange} />
    </header>
  );
}
