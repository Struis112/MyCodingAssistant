'use client';

import { ChatScreen } from '@/components/ChatScreen';
import { Dashboard } from '@/components/Dashboard';
import { Sidebar } from '@/components/Sidebar';
import { useAppStore } from '@/lib/store';

export function AppShell() {
  const { activeView } = useAppStore();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {activeView === 'chat' && <ChatScreen />}
        {activeView === 'dashboard' && <Dashboard />}
      </main>
    </div>
  );
}
