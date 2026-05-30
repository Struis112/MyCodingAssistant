// Global state management with Zustand
import { create } from 'zustand';

export type View = 'chat' | 'dashboard' | 'settings' | 'avatar';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export interface ServiceStatus {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  uptime?: number;
  restartCount: number;
  enabled: boolean;
  cpu?: number;
  memory?: number;
}

interface AppState {
  // View
  activeView: View;
  setActiveView: (view: View) => void;

  // Chat
  messages: Message[];
  addMessage: (message: Message) => void;
  updateMessage: (id: string, content: string) => void;
  clearMessages: () => void;
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;

  // Session
  sessionId: string;
  setSessionId: (id: string) => void;

  // Services
  services: ServiceStatus[];
  setServices: (services: ServiceStatus[]) => void;
  updateService: (name: string, status: Partial<ServiceStatus>) => void;

  // Connection
  isConnected: boolean;
  setIsConnected: (connected: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // View
  activeView: 'chat',
  setActiveView: (view) => set({ activeView: view }),

  // Chat
  messages: [],
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, content) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, content } : m)),
    })),
  clearMessages: () => set({ messages: [] }),
  isStreaming: false,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),

  // Session
  sessionId: 'default',
  setSessionId: (id) => set({ sessionId: id }),

  // Services
  services: [],
  setServices: (services) => set({ services }),
  updateService: (name, status) =>
    set((state) => ({
      services: state.services.map((s) => (s.name === name ? { ...s, ...status } : s)),
    })),

  // Connection
  isConnected: false,
  setIsConnected: (connected) => set({ isConnected: connected }),
}));
