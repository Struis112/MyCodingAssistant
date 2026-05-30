"use client";

import { useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { connectSocket } from "@/lib/socket";
import { cn } from "@/lib/utils";
import { MessageSquare, Settings as SettingsIcon } from "lucide-react";

// Top of the menu bar.
const navItems = [{ id: "chat", icon: MessageSquare, label: "Chat" }] as const;

// Pinned to the bottom of the menu bar.
const bottomNavItems = [{ id: "settings", icon: SettingsIcon, label: "Settings" }] as const;

function navButtonClass(active: boolean): string {
  return cn(
    "w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
    active
      ? "bg-primary/20 text-primary"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
}

export function Sidebar() {
  const { activeView, setActiveView } = useAppStore();

  useEffect(() => {
    connectSocket();
  }, []);

  return (
    <aside className="w-16 border-r border-border flex flex-col items-center py-4 gap-2 bg-background transition-colors">
      <nav className="flex-1 flex flex-col gap-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={navButtonClass(activeView === item.id)}
              title={item.label}
              aria-label={item.label}
              aria-current={activeView === item.id ? "page" : undefined}
            >
              <Icon className="w-5 h-5" />
            </button>
          );
        })}
      </nav>

      <nav className="flex flex-col gap-2 mt-auto">
        {bottomNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={navButtonClass(activeView === item.id)}
              title={item.label}
              aria-label={item.label}
              aria-current={activeView === item.id ? "page" : undefined}
            >
              <Icon className="w-5 h-5" />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
