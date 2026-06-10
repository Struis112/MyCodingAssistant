"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, MessageSquare, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { sessionTitle } from "@/components/chat/utils";

/** Human-friendly "x time ago" for the session row metadata. */
function formatRelative(ts: number): string {
  if (!ts) return "unknown";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Persisted-session browser.
 *
 * Lists every session saved to `~/.pi/agent/sessions/` (delivered by the
 * server on `chat:list` → `chat:sessions`). Clicking a row resumes it via
 * `chat:resume`; the resulting `chat:resumed` event is handled by
 * useChatEvents — it replaces the items in the store and we switch the
 * active view back to "chat" so the user sees the rehydrated conversation.
 */
export function SessionsView() {
  const { persistedSessions, setPersistedSessions, setActiveView, openTab, openTabWithFile } =
    useAppStore();
  // Highlight any session that's open in a tab. useShallow keeps the derived
  // array stable across renders (a fresh array each call would loop React).
  const openFiles = useAppStore(
    useShallow((s) => s.tabOrder.map((id) => s.sessions[id]?.sessionFile)),
  );

  // The session awaiting delete confirmation (null = no dialog open). We keep
  // the whole descriptor so the dialog can show its name.
  const [pendingDelete, setPendingDelete] = useState<(typeof persistedSessions)[number] | null>(
    null,
  );

  const refresh = () => {
    getSocket().emit("chat:list");
  };

  useEffect(() => {
    const socket = getSocket();
    const onSessions = (sessions: typeof persistedSessions) => {
      setPersistedSessions(sessions || []);
    };
    socket.on("chat:sessions", onSessions);
    refresh();
    return () => {
      socket.off("chat:sessions", onSessions);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPersistedSessions]);

  function handleResume(sessionFilePath: string) {
    // Open (or focus) the session in its own tab; AppShell loads it by file.
    openTabWithFile(sessionFilePath);
    setActiveView("chat");
  }

  function handleNew() {
    // Fresh session in a new tab; AppShell emits chat:new for it.
    openTab();
    setActiveView("chat");
  }

  function confirmDelete() {
    if (!pendingDelete?.path) return;
    // Server deletes the file then broadcasts a refreshed `chat:sessions`, so
    // the row disappears without us mutating local state here.
    getSocket().emit("chat:delete", { sessionFile: pendingDelete.path });
    setPendingDelete(null);
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
        <FolderOpen className="w-5 h-5 text-primary" />
        <h1 className="text-sm font-semibold text-foreground">Sessions</h1>
        <div className="flex-1" />
        <button
          onClick={refresh}
          className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh list"
          aria-label="Refresh list"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        <button
          onClick={handleNew}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
          aria-label="Start a new chat"
        >
          <Plus className="w-4 h-4" />
          New Chat
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {persistedSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <FileText className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">No persisted sessions yet</p>
            <p className="text-xs mt-2">
              Start a chat — sessions auto-save to <code>~/.pi/agent/sessions/</code>
            </p>
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl mx-auto">
            {persistedSessions
              .slice()
              .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0))
              .map((session) => {
                const isActive = openFiles.includes(session.path);
                // Use the same title derivation as the chat header so the
                // names are consistent across views (strips timestamp prefix
                // and .json extension).
                const display =
                  session.name && session.name !== "Untitled"
                    ? session.name
                    : sessionTitle(session.path);
                return (
                  <div
                    key={session.path || session.id}
                    className={`group relative w-full p-3 border rounded-lg transition-colors ${
                      isActive
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:bg-accent/50"
                    }`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    {/* Resume: the row body is the clickable target. The delete
                        button sits outside it so we avoid nesting buttons. */}
                    <button
                      onClick={() => handleResume(session.path)}
                      className="w-full text-left"
                      aria-label={`Resume ${display}`}
                    >
                      <div className="flex items-start gap-3 pr-8">
                        <MessageSquare className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-card-foreground truncate">
                            {display}
                            {isActive && (
                              <span className="ml-2 text-xs text-primary">(active)</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 items-center">
                            <span>{formatRelative(session.modifiedAt)}</span>
                            {session.messageCount !== undefined && (
                              <span>· {session.messageCount} msgs</span>
                            )}
                          </div>
                          {session.path && (
                            <div className="text-xs text-muted-foreground/70 mt-1 truncate font-mono">
                              {session.path}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>

                    <button
                      onClick={() => setPendingDelete(session)}
                      className="absolute top-2 right-2 p-1.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-error/10 hover:text-error transition-colors"
                      title="Delete chat"
                      aria-label={`Delete ${display}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {pendingDelete && (
        <DeleteConfirm
          name={
            pendingDelete.name && pendingDelete.name !== "Untitled"
              ? pendingDelete.name
              : sessionTitle(pendingDelete.path)
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

/**
 * Modal confirmation for an irreversible delete. Deliberately minimal: one
 * clear primary action (Cancel, the safe default and autofocused) and a
 * destructive action. Escape cancels; clicking the backdrop cancels.
 */
function DeleteConfirm({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Programmatic focus on the safe-default (Cancel) avoids `autoFocus`.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop is a real <button> for accessibility (click + Enter/Space
          both cancel). Visually it's the dimmer behind the dialog. */}
      <button
        type="button"
        aria-label="Dismiss dialog"
        onClick={onCancel}
        className="absolute inset-0 w-full h-full cursor-default bg-black/50"
      />
      <div
        className="relative w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-lg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-desc"
      >
        <h2 id="delete-title" className="text-sm font-semibold text-card-foreground">
          Delete this chat?
        </h2>
        <p id="delete-desc" className="mt-2 text-sm text-muted-foreground">
          “{name}” will be permanently removed from disk. This can’t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded border border-border text-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded bg-error/20 text-error font-medium hover:bg-error/30 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
