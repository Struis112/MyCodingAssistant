"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore, type SessionState } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { cn } from "@/lib/utils";

/** Tab label: explicit name → precomputed title (first user message) → default.
 *  Uses the stored `title` so we don't scan messages on every streaming token. */
function deriveLabel(s: SessionState): string {
  if (s.name) return s.name;
  if (s.title) return s.title.length > 28 ? `${s.title.slice(0, 28)}…` : s.title;
  return "New chat";
}

/**
 * Tab bar across the top of the chat screen — one tab per open session.
 * Shows a live activity badge (unread output in a background tab) and a
 * streaming spinner. Double-click to rename, middle-click or × to close.
 * Switching/opening updates the store; AppShell loads the session.
 */
export function ChatTabs() {
  // Subscribe to the whole sessions map: the bar must reflect live per-tab
  // streaming/unread. It's a tiny component, so re-rendering is cheap.
  const sessions = useAppStore((s) => s.sessions);
  const tabOrder = useAppStore((s) => s.tabOrder);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const { openTab, switchTab, closeTab, renameTab, moveTab } = useAppStore(
    useShallow((s) => ({
      openTab: s.openTab,
      switchTab: s.switchTab,
      closeTab: s.closeTab,
      renameTab: s.renameTab,
      moveTab: s.moveTab,
    })),
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Drag-to-reorder state: the tab being dragged and the one it's hovering over.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const commitRename = (id: string) => {
    const name = draft.trim();
    setEditingId(null);
    if (!name) return;
    renameTab(id, name); // optimistic; server echoes session:nameChanged
    getSocket().emit("session:setName", { sessionId: id, name });
  };

  return (
    <div className="flex items-center gap-1 h-8 shrink-0 border-b border-border bg-background px-2 overflow-x-auto">
      {tabOrder.map((id) => {
        const ses = sessions[id];
        if (!ses) return null;
        const active = id === activeSessionId;
        const label = deriveLabel(ses);
        const editing = editingId === id;

        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            draggable={!editing}
            onDragStart={(e) => {
              setDragId(id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overId !== id) setOverId(id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) moveTab(dragId, id);
              setDragId(null);
              setOverId(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onClick={() => !active && !editing && switchTab(id)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !active && !editing) {
                e.preventDefault();
                switchTab(id);
              }
            }}
            onDoubleClick={() => {
              setEditingId(id);
              setDraft(ses.name ?? "");
            }}
            onAuxClick={(e) => {
              if (e.button === 1 && tabOrder.length > 1) {
                e.preventDefault();
                closeTab(id);
              }
            }}
            title={editing ? undefined : `${label} — double-click to rename, drag to reorder`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-1.5 h-6 pl-2.5 pr-1.5 rounded-md text-xs cursor-pointer max-w-[200px] shrink-0 border transition-colors",
              active
                ? "bg-muted text-foreground border-border"
                : "text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground",
              dragId === id && "opacity-50",
              overId === id && dragId && dragId !== id && "border-primary/60",
            )}
          >
            {/* streaming spinner / unread dot */}
            {ses.isStreaming ? (
              <Loader2 className="w-3 h-3 shrink-0 animate-spin text-info" />
            ) : (
              !active &&
              ses.unread && (
                <span
                  className="w-1.5 h-1.5 shrink-0 rounded-full bg-info"
                  aria-label="new activity"
                />
              )
            )}

            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(id);
                  } else if (e.key === "Escape") {
                    setEditingId(null);
                  }
                }}
                className="w-28 bg-background border border-border rounded px-1 text-xs outline-none focus:border-primary"
                aria-label="Rename tab"
              />
            ) : (
              <span className="truncate">{label}</span>
            )}

            {tabOrder.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id);
                }}
                className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background hover:text-error focus:opacity-100"
                title="Close tab"
                aria-label={`Close ${label}`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}

      <button
        onClick={() => openTab()}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="New chat tab (Alt+T)"
        aria-label="New chat tab"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
