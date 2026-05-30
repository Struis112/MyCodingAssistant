"use client";

import { useEffect } from "react";
import { ChatScreen } from "@/components/ChatScreen";
import { SessionsView } from "@/components/SessionsView";
import { Settings } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { useAppStore, readPersistedUserPrefs } from "@/lib/store";
import { getSocket } from "@/lib/socket";

export function AppShell() {
  const { activeView, sessionId, currentModel, thinkingLevel, setCurrentModel, setThinkingLevel } =
    useAppStore();

  // Hydrate persisted prefs after mount. Doing this here — instead of in the
  // store's initial state — keeps SSR + first client render byte-identical,
  // which avoids the hydration-mismatch error in the chat header.
  useEffect(() => {
    const prefs = readPersistedUserPrefs();
    if (prefs.currentModel) setCurrentModel(prefs.currentModel);
    if (prefs.thinkingLevel) setThinkingLevel(prefs.thinkingLevel);
    // Empty deps: run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On every socket connect (initial + reconnect):
  //   1. ask the server for the current session state
  //   2. when it answers, re-apply our localStorage-persisted prefs
  //      (thinking level + model) so a server restart doesn't lose them.
  useEffect(() => {
    const socket = getSocket();

    const sendInit = () => {
      socket.emit("chat:state", { sessionId });
    };

    const onState = (data: {
      sessionId: string;
      state: null | {
        model: { id: string; name: string; provider: string } | null;
        thinkingLevel: string;
      };
    }) => {
      if (data.sessionId !== sessionId) return;

      // Pull the model the server reports (it may have one from the
      // restored session file even when localStorage is empty).
      if (data.state?.model && !currentModel) {
        setCurrentModel(data.state.model);
      }

      // Re-apply our remembered thinking level if the fresh session
      // doesn't match. Default ('off') is fine, but if the user picked
      // 'low'/'medium'/'high' we want every new session to honor it.
      const desiredLevel = thinkingLevel;
      const serverLevel = data.state?.thinkingLevel ?? "off";
      if (desiredLevel && desiredLevel !== serverLevel) {
        socket.emit("session:setThinkingLevel", { sessionId, level: desiredLevel });
      }

      // Same for the model: if we remember one and the server doesn't
      // have it, push it.
      if (currentModel && !data.state?.model) {
        socket.emit("session:setModel", {
          sessionId,
          provider: currentModel.provider,
          modelId: currentModel.id,
        });
      }
    };

    socket.on("connect", sendInit);
    socket.on("chat:state:result", onState);

    if (socket.connected) sendInit();

    return () => {
      socket.off("connect", sendInit);
      socket.off("chat:state:result", onState);
    };
  }, [sessionId, currentModel, thinkingLevel, setCurrentModel, setThinkingLevel]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {activeView === "chat" && <ChatScreen />}
        {activeView === "sessions" && <SessionsView />}
        {activeView === "settings" && <Settings />}
      </main>
    </div>
  );
}
