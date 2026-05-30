'use client';

import { useEffect } from 'react';
import { ChatScreen } from '@/components/ChatScreen';
import { Settings } from '@/components/Settings';
import { SessionsView } from '@/components/SessionsView';
import { Sidebar } from '@/components/Sidebar';
import { useAppStore } from '@/lib/store';
import { getSocket } from '@/lib/socket';

export function AppShell() {
  const { activeView, sessionId, setCurrentModel } = useAppStore();

  // On first connect, ask the server to attach our session and report its state.
  useEffect(() => {
    const socket = getSocket();

    const sendInit = () => {
      socket.emit('chat:state', { sessionId });
    };

    const onState = (data: {
      sessionId: string;
      state: null | {
        model: { id: string; name: string; provider: string } | null;
      };
    }) => {
      if (data.sessionId !== sessionId) return;
      if (data.state?.model) setCurrentModel(data.state.model);
    };

    socket.on('connect', sendInit);
    socket.on('chat:state:result', onState);

    if (socket.connected) sendInit();

    return () => {
      socket.off('connect', sendInit);
      socket.off('chat:state:result', onState);
    };
  }, [sessionId, setCurrentModel]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {activeView === 'chat' && <ChatScreen />}
        {activeView === 'sessions' && <SessionsView />}
        {activeView === 'settings' && <Settings />}
      </main>
    </div>
  );
}
