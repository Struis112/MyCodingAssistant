'use client';

import { useState, useRef, useEffect } from 'react';
import { useAppStore, Message } from '@/lib/store';
import { getSocket } from '@/lib/socket';
import { generateId, formatTimestamp, cn } from '@/lib/utils';
import { Send, Square, Trash2, Terminal } from 'lucide-react';

export function ChatScreen() {
  const { messages, addMessage, updateMessage, clearMessages, isStreaming, setIsStreaming, sessionId } =
    useAppStore();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Listen for streaming events
  useEffect(() => {
    const socket = getSocket();

    socket.on('chat:event', (data: { sessionId: string; event: any }) => {
      if (data.sessionId !== sessionId) return;

      const { event } = data;
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'assistant') {
          updateMessage(lastMsg.id, lastMsg.content + delta);
        }
      }
    });

    socket.on('chat:done', () => {
      setIsStreaming(false);
    });

    socket.on('chat:error', (data: { error: string }) => {
      addMessage({
        id: generateId(),
        role: 'system',
        content: `Error: ${data.error}`,
        timestamp: Date.now(),
      });
      setIsStreaming(false);
    });

    return () => {
      socket.off('chat:event');
      socket.off('chat:done');
      socket.off('chat:error');
    };
  }, [sessionId, messages, addMessage, updateMessage, setIsStreaming]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };

    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    addMessage(userMessage);
    addMessage(assistantMessage);
    setIsStreaming(true);

    const socket = getSocket();
    socket.emit('chat:send', { sessionId, message: input.trim() });

    setInput('');
    inputRef.current?.focus();
  };

  const handleAbort = () => {
    const socket = getSocket();
    socket.emit('chat:abort', { sessionId });
    setIsStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="h-12 border-b border-border flex items-center px-4 gap-3">
        <Terminal className="w-5 h-5 text-primary" />
        <h1 className="text-sm font-semibold text-foreground">Chat</h1>
        <div className="flex-1" />
        {isStreaming && (
          <span className="text-xs text-warning animate-pulse">● Streaming...</span>
        )}
        <button
          onClick={clearMessages}
          className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Clear chat"
          aria-label="Clear chat"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Terminal className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">Start a conversation with your AI assistant</p>
            <p className="text-xs mt-2">Type a message and press Enter to begin</p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Enter to send, Shift+Enter for newline)"
            className="flex-1 bg-background border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary resize-none min-h-[44px] max-h-[200px] transition-colors"
            rows={1}
            disabled={isStreaming}
            aria-label="Message input"
          />
          {isStreaming ? (
            <button
              onClick={handleAbort}
              className="px-4 py-2 bg-error/20 text-error rounded-lg hover:bg-error/30 transition-colors"
              aria-label="Stop streaming"
            >
              <Square className="w-5 h-5" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Send message"
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2 transition-colors',
          isSystem
            ? 'bg-warning/10 border border-warning/30 text-warning'
            : isUser
            ? 'bg-primary/20 text-foreground'
            : 'bg-muted text-foreground'
        )}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase">
            {isSystem ? 'System' : isUser ? 'You' : 'Assistant'}
          </span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(message.timestamp)}</span>
          {message.isStreaming && message.content === '' && (
            <span className="inline-block w-2 h-4 bg-primary cursor-blink" />
          )}
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono">
          {message.content}
          {message.isStreaming && message.content && (
            <span className="inline-block w-2 h-4 bg-primary cursor-blink ml-0.5" />
          )}
        </pre>
      </div>
    </div>
  );
}
