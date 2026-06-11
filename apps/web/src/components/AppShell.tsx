"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { ChatScreen } from "@/components/ChatScreen";
import { SessionsView } from "@/components/SessionsView";
import { ServicesView } from "@/components/ServicesView";
import { Settings } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { useAppStore, readPersistedUserPrefs, readPersistedTabs, type View } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { getSocket } from "@/lib/socket";

export function AppShell() {
  // Selective subscription (useShallow): the shell must NOT re-render on every
  // streaming token (which mutates `items`) — only when these slices change.
  const {
    activeView,
    activeSessionId,
    sessionName,
    tabOrder,
    pendingNewTab,
    isConnected,
    setActiveView,
    setCurrentModel,
    setThinkingLevel,
    setIsConnected,
    hydrateTabs,
  } = useAppStore(
    useShallow((s) => ({
      activeView: s.activeView,
      activeSessionId: s.activeSessionId,
      sessionName: s.sessions[s.activeSessionId]?.name ?? null,
      tabOrder: s.tabOrder,
      pendingNewTab: s.pendingNewTab,
      isConnected: s.isConnected,
      setActiveView: s.setActiveView,
      setCurrentModel: s.setCurrentModel,
      setThinkingLevel: s.setThinkingLevel,
      setIsConnected: s.setIsConnected,
      hydrateTabs: s.hydrateTabs,
    })),
  );

  // Which tabs we've already sent an initial load for (so newly-opened tabs get
  // loaded without re-loading everything). Reset on (re)connect.
  const loadedRef = useRef<Set<string>>(new Set());
  const loadTabRef = useRef<(id: string) => void>(() => {});

  // Track the live socket connection so we can show a calm "Reconnecting…"
  // indicator during a brief outage (e.g. a deploy restart) instead of a
  // silent, seemingly-frozen page.
  const everConnected = useRef(false);
  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => {
      everConnected.current = true;
      setIsConnected(true);
    };
    const onDisconnect = () => setIsConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    if (socket.connected) {
      everConnected.current = true;
      setIsConnected(true);
    }
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [setIsConnected]);

  // Auto-reload-on-redeploy: the server reports the current frontend build id
  // on every (re)connect. We remember the first id we saw (the bundle this tab
  // is running) and reload ONCE when a newer one appears — so a deploy refreshes
  // open tabs automatically, no manual Ctrl+F5.
  const buildIdBaseline = useRef<string | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const onVersion = (data: { buildId?: string | null }) => {
      const id = data?.buildId;
      if (!id) return; // dev / pre-build: don't force reloads
      if (buildIdBaseline.current === null) {
        buildIdBaseline.current = id;
        return;
      }
      if (id !== buildIdBaseline.current) {
        // A newer frontend was deployed — pick it up.
        window.location.reload();
      }
    };
    socket.on("app:version", onVersion);
    return () => {
      socket.off("app:version", onVersion);
    };
  }, []);

  // Keep the browser tab title in sync with the session's display name.
  useEffect(() => {
    document.title = sessionName ? `${sessionName} — MyCodingAssistant` : "MyCodingAssistant";
  }, [sessionName]);

  // Alt+1..4 switches the main view. Alt (not Ctrl/Cmd) avoids clobbering the
  // browser's number-key tab shortcuts.
  useEffect(() => {
    const order: View[] = ["chat", "sessions", "services", "settings"];
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number.parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= order.length) {
        e.preventDefault();
        setActiveView(order[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveView]);

  // Tab keyboard shortcuts: Alt+T new, Alt+W close active, Alt+Up/Down cycle,
  // plus Ctrl+Tab / Ctrl+Shift+Tab next/previous (the familiar convention).
  // (Alt+Left/Right are the browser's back/forward, so we use Up/Down. Note:
  // some browsers reserve Ctrl+Tab for their own tab switching and never let
  // the page see it — Alt+Up/Down always works as the fallback.)
  useEffect(() => {
    const cycle = (dir: 1 | -1) => {
      const s = useAppStore.getState();
      if (s.tabOrder.length < 2) return;
      const idx = s.tabOrder.indexOf(s.activeSessionId);
      const len = s.tabOrder.length;
      s.switchTab(s.tabOrder[(idx + dir + len) % len]!);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const s = useAppStore.getState();
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        s.openTab();
        s.setActiveView("chat");
      } else if (k === "w") {
        e.preventDefault();
        s.closeTab(s.activeSessionId);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        cycle(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hydrate persisted prefs after mount. Doing this here — instead of in the
  // store's initial state — keeps SSR + first client render byte-identical,
  // which avoids the hydration-mismatch error in the chat header.
  useEffect(() => {
    const prefs = readPersistedUserPrefs();
    if (prefs.currentModel) setCurrentModel(prefs.currentModel);
    if (prefs.thinkingLevel) setThinkingLevel(prefs.thinkingLevel);
    // Restore open tabs + active tab (sets sessionId/sessionFile/name from the
    // active tab); the connect effect then loads it from the server.
    const t = readPersistedTabs();
    hydrateTabs(t.tabs, t.activeId);
    // Empty deps: run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load every open tab on (re)connect so background tabs join their rooms and
  // stream live; re-apply remembered model/thinking for the active session.
  // Registered once — handlers read the latest store via getState().
  useEffect(() => {
    const socket = getSocket();

    const loadTab = (id: string) => {
      const s = useAppStore.getState();
      const ses = s.sessions[id];
      if (!ses) return;
      if (ses.sessionFile) {
        // A tab bound to a session file is ALWAYS restored — never new'd — even
        // if a stale pendingNewTab flag is set, so opening a session can't wipe
        // its history.
        socket.emit("chat:state", { sessionId: id, sessionFile: ses.sessionFile });
      } else {
        // No file yet (a fresh tab) → start an empty session.
        socket.emit("chat:new", { sessionId: id });
      }
      if (s.pendingNewTab && id === s.activeSessionId) s.clearPendingNewTab();
      loadedRef.current.add(id);
    };
    loadTabRef.current = loadTab;

    const onConnect = () => {
      loadedRef.current.clear();
      for (const id of useAppStore.getState().tabOrder) loadTab(id);
    };

    // Re-apply remembered model/thinking to the ACTIVE session when the server
    // reports its state. (Names + items are handled in useChatEvents.)
    const onState = (data: {
      sessionId: string;
      state: null | {
        model: { id: string; name: string; provider: string } | null;
        thinkingLevel: string;
      };
    }) => {
      const s = useAppStore.getState();
      if (data.sessionId !== s.activeSessionId) return;
      if (data.state?.model && !s.currentModel) s.setCurrentModel(data.state.model);
      const serverLevel = data.state?.thinkingLevel ?? "off";
      if (s.thinkingLevel && s.thinkingLevel !== serverLevel) {
        socket.emit("session:setThinkingLevel", {
          sessionId: data.sessionId,
          level: s.thinkingLevel,
        });
      }
      if (s.currentModel && !data.state?.model) {
        socket.emit("session:setModel", {
          sessionId: data.sessionId,
          provider: s.currentModel.provider,
          modelId: s.currentModel.id,
        });
      }
    };

    socket.on("connect", onConnect);
    socket.on("chat:state:result", onState);
    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("chat:state:result", onState);
    };
  }, []);

  // Load any newly-opened tab (and the active one) once connected.
  useEffect(() => {
    if (!getSocket().connected) return;
    for (const id of tabOrder) {
      if (!loadedRef.current.has(id)) loadTabRef.current(id);
    }
  }, [tabOrder, activeSessionId, pendingNewTab]);

  // ----- Cross-device tab sync -----
  // The set of open (file-backed) conversations is shared via the server, so
  // every device shows the same tabs. New empty tabs stay local until they get
  // a session file. The server is authoritative once seeded; the first device
  // with tabs seeds it instead of being wiped by an empty list.
  const applyingRemoteTabs = useRef(false);
  const syncedTabsRef = useRef(false);
  const sharedTabsSig = useAppStore((s) =>
    s.tabOrder
      .map((id) => s.sessions[id])
      .filter((x) => x?.sessionFile)
      .map((x) => `${x!.sessionFile}\u0001${x!.name ?? ""}`)
      .join("\u0002"),
  );
  useEffect(() => {
    const socket = getSocket();
    const localShared = () => {
      const s = useAppStore.getState();
      return s.tabOrder
        .map((id) => s.sessions[id])
        .filter((x) => x?.sessionFile)
        .map((x) => ({ sessionFile: x!.sessionFile as string, name: x!.name }));
    };
    const onSync = (data: { tabs?: Array<{ sessionFile: string; name: string | null }> }) => {
      const serverTabs = data.tabs ?? [];
      if (serverTabs.length === 0 && localShared().length > 0) {
        // Server empty but we have tabs → seed it (don't let an empty list wipe us).
        syncedTabsRef.current = true;
        socket.emit("tabs:set", { tabs: localShared() });
        return;
      }
      applyingRemoteTabs.current = true;
      useAppStore.getState().applyServerTabs(serverTabs);
      syncedTabsRef.current = true;
      setTimeout(() => {
        applyingRemoteTabs.current = false;
      }, 0);
    };
    const onConnect = () => socket.emit("tabs:get");
    socket.on("tabs:sync", onSync);
    socket.on("connect", onConnect);
    if (socket.connected) socket.emit("tabs:get");
    return () => {
      socket.off("tabs:sync", onSync);
      socket.off("connect", onConnect);
    };
  }, []);
  // Push our file-backed tab list whenever it changes (after the first sync).
  useEffect(() => {
    if (!syncedTabsRef.current || applyingRemoteTabs.current) return;
    if (!getSocket().connected) return;
    const s = useAppStore.getState();
    const tabs = s.tabOrder
      .map((id) => s.sessions[id])
      .filter((x) => x?.sessionFile)
      .map((x) => ({ sessionFile: x!.sessionFile as string, name: x!.name }));
    getSocket().emit("tabs:set", { tabs });
  }, [sharedTabsSig]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Keyboard users can jump straight to the main content past the sidebar. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>
      {/* Floating pill only outside the chat view — the chat header shows its
          own "Reconnecting…" in the top-right corner (one calm signal, not two). */}
      {!isConnected && everConnected.current && activeView !== "chat" && (
        <output
          aria-live="polite"
          className="fixed top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-medium text-warning shadow-sm"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Reconnecting…
        </output>
      )}
      <Sidebar />
      <main id="main-content" tabIndex={-1} className="flex-1 flex flex-col overflow-hidden">
        {activeView === "chat" && <ChatScreen />}
        {activeView === "sessions" && <SessionsView />}
        {activeView === "services" && <ServicesView />}
        {activeView === "settings" && <Settings />}
      </main>
    </div>
  );
}
