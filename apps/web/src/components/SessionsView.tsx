"use client";

import { useEffect } from "react";
import { FileText, FolderOpen, MessageSquare, Plus, RefreshCw } from "lucide-react";
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
  const { persistedSessions, setPersistedSessions, sessionId, sessionFile, setActiveView } =
    useAppStore();

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
    getSocket().emit("chat:resume", { sessionId, sessionFile: sessionFilePath });
    setActiveView("chat");
  }

  function handleNew() {
    getSocket().emit("chat:new", { sessionId });
    setActiveView("chat");
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
                const isActive = session.path === sessionFile;
                // Use the same title derivation as the chat header so the
                // names are consistent across views (strips timestamp prefix
                // and .json extension).
                const display =
                  session.name && session.name !== "Untitled"
                    ? session.name
                    : sessionTitle(session.path);
                return (
                  <button
                    key={session.path || session.id}
                    onClick={() => handleResume(session.path)}
                    className={`w-full text-left p-3 border rounded-lg transition-colors ${
                      isActive
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:bg-accent/50"
                    }`}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="flex items-start gap-3">
                      <MessageSquare className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-card-foreground truncate">
                          {display}
                          {isActive && <span className="ml-2 text-xs text-primary">(active)</span>}
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
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
