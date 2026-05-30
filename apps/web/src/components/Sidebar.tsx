'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { connectSocket, getSocket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { MessageSquare, LayoutDashboard, Settings as SettingsIcon, Bot, Wifi, WifiOff, Camera } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

const navItems = [
  { id: 'chat', icon: MessageSquare, label: 'Chat' },
  { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { id: 'avatar', icon: Bot, label: 'Avatar' },
  { id: 'camera', icon: Camera, label: 'Camera' },
  { id: 'settings', icon: SettingsIcon, label: 'Settings' },
] as const;

export function Sidebar() {
  const { activeView, setActiveView, isConnected, setIsConnected } = useAppStore();

  useEffect(() => {
    const socket = getSocket();

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    connectSocket();

    return () => {
      socket.off('connect');
      socket.off('disconnect');
    };
  }, [setIsConnected]);

  return (
    <aside
      className={cn(
        'w-16 border-r border-border flex flex-col items-center py-4 gap-2 transition-colors bg-background'
      )}
    >
      {/* Logo */}
      <div className="w-10 h-10 rounded-lg flex items-center justify-center mb-4 bg-primary/20">
        <Bot className="w-6 h-6 text-primary" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={cn(
                'w-10 h-10 rounded-lg flex items-center justify-center transition-colors',
                activeView === item.id
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
              title={item.label}
              aria-label={item.label}
              aria-current={activeView === item.id ? 'page' : undefined}
            >
              <Icon className="w-5 h-5" />
            </button>
          );
        })}
      </nav>

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Connection status */}
      <div className="flex flex-col items-center gap-1 mt-2">
        {isConnected ? (
          <Wifi className="w-5 h-5 text-success" aria-label="Connected" />
        ) : (
          <WifiOff className="w-5 h-5 text-error" aria-label="Disconnected" />
        )}
        <span className="text-[10px] text-muted-foreground">
          {isConnected ? 'Online' : 'Offline'}
        </span>
      </div>
    </aside>
  );
}
