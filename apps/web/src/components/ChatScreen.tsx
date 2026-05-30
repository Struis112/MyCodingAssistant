'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore, type ChatItem, type ContentBlock } from '@/lib/store';
import { getSocket } from '@/lib/socket';
import { generateId, formatTimestamp, cn } from '@/lib/utils';
import {
  Send,
  Square,
  Trash2,
  Terminal,
  Wrench,
  Check,
  X,
  Loader2,
  Brain,
  Plus,
} from 'lucide-react';

// ----- helpers to translate persisted AgentMessage[] into ChatItem[] -----

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && (c as RawContentBlock).type === 'text')
      .map((c) => (c as RawContentBlock).text || '')
      .join('');
  }
  return '';
}

function agentMessagesToChatItems(messages: RawMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of messages || []) {
    const ts = msg.timestamp || Date.now();
    if (msg.role === 'user') {
      const text = extractText(msg.content);
      if (text) items.push({ kind: 'user', id: generateId(), text, timestamp: ts });
    } else if (msg.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      const content = Array.isArray(msg.content) ? (msg.content as RawContentBlock[]) : [];
      for (const c of content) {
        if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text });
        else if (c.type === 'thinking' && c.thinking)
          blocks.push({ type: 'thinking', text: c.thinking });
        else if (c.type === 'toolCall' && c.id && c.name) {
          items.push({
            kind: 'tool',
            id: generateId(),
            toolCallId: c.id,
            toolName: c.name,
            args: c.arguments,
            status: 'success',
            timestamp: ts,
          });
        }
      }
      if (blocks.length > 0) {
        items.push({
          kind: 'assistant',
          id: generateId(),
          blocks,
          timestamp: ts,
          isStreaming: false,
        });
      }
    } else if (msg.role === 'toolResult' && msg.toolCallId) {
      const target = items.find(
        (it) => it.kind === 'tool' && it.toolCallId === msg.toolCallId
      );
      if (target && target.kind === 'tool') {
        target.result = msg.content;
        target.isError = !!msg.isError;
        target.status = msg.isError ? 'error' : 'success';
      }
    }
  }
  return items;
}

// ----- main component -----

export function ChatScreen() {
  const {
    items,
    addItem,
    updateItem,
    findToolItemByCallId,
    clearItems,
    setItems,
    isStreaming,
    setIsStreaming,
    sessionId,
    sessionFile,
    setSessionFile,
    currentModel,
    setActiveView,
  } = useAppStore();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  // ----- SDK event handler -----

  useEffect(() => {
    const socket = getSocket();

    const onEvent = (data: { sessionId: string; event: any }) => {
      if (data.sessionId !== sessionId) return;
      const ev = data.event;
      if (!ev || typeof ev !== 'object') return;

      // ---- assistant message lifecycle ----
      if (ev.type === 'message_start' && ev.message?.role === 'assistant') {
        const id = generateId();
        currentAssistantIdRef.current = id;
        addItem({
          kind: 'assistant',
          id,
          blocks: [],
          timestamp: Date.now(),
          isStreaming: true,
        });
        return;
      }

      if (ev.type === 'message_update') {
        const sub = ev.assistantMessageEvent;
        const currentId = currentAssistantIdRef.current;
        if (!sub || !currentId) return;

        const appendToLastBlock = (
          blockType: 'text' | 'thinking',
          delta: string
        ) => {
          updateItem(currentId, (it) => {
            if (it.kind !== 'assistant') return it;
            const blocks = [...it.blocks];
            let idx = -1;
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i].type === blockType) {
                idx = i;
                break;
              }
            }
            if (idx === -1) {
              blocks.push({ type: blockType, text: delta, isStreaming: true });
            } else {
              const b = blocks[idx] as { type: typeof blockType; text: string; isStreaming?: boolean };
              blocks[idx] = { type: blockType, text: b.text + delta, isStreaming: true };
            }
            return { ...it, blocks };
          });
        };

        const finishBlock = (blockType: 'text' | 'thinking') => {
          updateItem(currentId, (it) => {
            if (it.kind !== 'assistant') return it;
            const blocks = it.blocks.map((b) =>
              b.type === blockType && b.isStreaming ? { ...b, isStreaming: false } : b
            );
            return { ...it, blocks };
          });
        };

        switch (sub.type) {
          case 'text_start':
            updateItem(currentId, (it) =>
              it.kind === 'assistant'
                ? { ...it, blocks: [...it.blocks, { type: 'text', text: '', isStreaming: true }] }
                : it
            );
            return;
          case 'text_delta':
            appendToLastBlock('text', sub.delta || '');
            return;
          case 'text_end':
            finishBlock('text');
            return;
          case 'thinking_start':
            updateItem(currentId, (it) =>
              it.kind === 'assistant'
                ? { ...it, blocks: [...it.blocks, { type: 'thinking', text: '', isStreaming: true }] }
                : it
            );
            return;
          case 'thinking_delta':
            appendToLastBlock('thinking', sub.delta || '');
            return;
          case 'thinking_end':
            finishBlock('thinking');
            return;
        }
        return;
      }

      if (ev.type === 'message_end') {
        const currentId = currentAssistantIdRef.current;
        if (currentId) {
          updateItem(currentId, (it) =>
            it.kind === 'assistant' ? { ...it, isStreaming: false } : it
          );
        }
        currentAssistantIdRef.current = null;
        return;
      }

      // ---- tool execution lifecycle ----
      if (ev.type === 'tool_execution_start') {
        if (findToolItemByCallId(ev.toolCallId)) return;
        addItem({
          kind: 'tool',
          id: generateId(),
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args,
          status: 'running',
          timestamp: Date.now(),
        });
        return;
      }

      if (ev.type === 'tool_execution_update') {
        const existing = findToolItemByCallId(ev.toolCallId);
        if (!existing || existing.kind !== 'tool') return;
        updateItem(existing.id, (it) =>
          it.kind === 'tool' ? { ...it, result: ev.partialResult } : it
        );
        return;
      }

      if (ev.type === 'tool_execution_end') {
        const existing = findToolItemByCallId(ev.toolCallId);
        if (!existing || existing.kind !== 'tool') return;
        updateItem(existing.id, (it) =>
          it.kind === 'tool'
            ? {
                ...it,
                result: ev.result,
                isError: !!ev.isError,
                status: ev.isError ? 'error' : 'success',
              }
            : it
        );
        return;
      }
    };

    const onDone = (data: { sessionId: string }) => {
      if (data.sessionId !== sessionId) return;
      setIsStreaming(false);
      // Defensive: any lingering streaming blocks get finalized
      const current = currentAssistantIdRef.current;
      if (current) {
        updateItem(current, (it) =>
          it.kind === 'assistant' ? { ...it, isStreaming: false } : it
        );
        currentAssistantIdRef.current = null;
      }
    };

    const onError = (data: { sessionId: string; error: string }) => {
      if (data.sessionId !== sessionId) return;
      addItem({
        kind: 'system',
        id: generateId(),
        text: `Error: ${data.error}`,
        timestamp: Date.now(),
      });
      setIsStreaming(false);
    };

    const onResumed = (data: {
      sessionId: string;
      sessionFile?: string;
      messages?: RawMessage[];
    }) => {
      if (data.sessionId !== sessionId) return;
      setSessionFile(data.sessionFile);
      const restored = agentMessagesToChatItems(data.messages || []);
      setItems(restored);
    };

    const onNew = (data: { sessionId: string; sessionFile?: string }) => {
      if (data.sessionId !== sessionId) return;
      setSessionFile(data.sessionFile);
      clearItems();
    };

    socket.on('chat:event', onEvent);
    socket.on('chat:done', onDone);
    socket.on('chat:error', onError);
    socket.on('chat:resumed', onResumed);
    socket.on('chat:new', onNew);

    return () => {
      socket.off('chat:event', onEvent);
      socket.off('chat:done', onDone);
      socket.off('chat:error', onError);
      socket.off('chat:resumed', onResumed);
      socket.off('chat:new', onNew);
    };
  }, [
    sessionId,
    addItem,
    updateItem,
    findToolItemByCallId,
    setIsStreaming,
    setItems,
    clearItems,
    setSessionFile,
  ]);

  // ----- actions -----

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    // Optimistically render the user message. The server decides whether to
    // route it as a fresh prompt or queue it as a `steer` based on whether
    // the agent is currently streaming — either way we want the UI to feel
    // continuous, so we never block typing or sending.
    addItem({ kind: 'user', id: generateId(), text, timestamp: Date.now() });
    if (!isStreaming) setIsStreaming(true);
    getSocket().emit('chat:send', { sessionId, message: text });
    setInput('');
    inputRef.current?.focus();
  }, [input, isStreaming, sessionId, addItem, setIsStreaming]);

  const handleAbort = useCallback(() => {
    getSocket().emit('chat:abort', { sessionId });
    setIsStreaming(false);
  }, [sessionId, setIsStreaming]);

  const handleNewChat = useCallback(() => {
    getSocket().emit('chat:new', { sessionId });
  }, [sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="h-12 border-b border-border flex items-center px-4 gap-3 shrink-0">
        <Terminal className="w-5 h-5 text-primary" />
        <h1 className="text-sm font-semibold text-foreground">Chat</h1>
        {currentModel && (
          <span className="text-xs text-muted-foreground hidden sm:inline">
            · {currentModel.name}
          </span>
        )}
        <div className="flex-1" />
        {isStreaming && (
          <span className="text-xs text-warning animate-pulse">● Streaming...</span>
        )}
        <button
          onClick={() => setActiveView('sessions')}
          className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Browse sessions"
          aria-label="Browse sessions"
        >
          <Terminal className="w-4 h-4" />
        </button>
        <button
          onClick={handleNewChat}
          className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="New chat"
          aria-label="New chat"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          onClick={clearItems}
          className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Clear visible messages (does not delete persisted session)"
          aria-label="Clear view"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Terminal className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">Start a conversation with your AI assistant</p>
            <p className="text-xs mt-2">Type a message and press Enter to begin</p>
          </div>
        )}

        {items.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-4 shrink-0">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming
                ? 'Queue a message... (Enter to steer, Shift+Enter for newline)'
                : 'Type your message... (Enter to send, Shift+Enter for newline)'
            }
            className="flex-1 bg-background border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary resize-none min-h-[44px] max-h-[200px] transition-colors"
            rows={1}
            aria-label="Message input"
          />
          {isStreaming && (
            <button
              onClick={handleAbort}
              className="px-4 py-2 bg-error/20 text-error rounded-lg hover:bg-error/30 transition-colors"
              aria-label="Stop streaming"
              title="Stop the current response"
            >
              <Square className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={isStreaming ? 'Queue message' : 'Send message'}
            title={
              isStreaming
                ? 'Queue this message — delivered after the current assistant turn'
                : 'Send message'
            }
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Item rendering =====

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <UserItem item={item} />;
    case 'assistant':
      return <AssistantItem item={item} />;
    case 'tool':
      return <ToolItem item={item} />;
    case 'system':
      return <SystemItem item={item} />;
  }
}

function UserItem({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] bg-primary/20 text-foreground rounded-lg px-4 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase">You</span>
          <span className="text-xs text-muted-foreground">
            {formatTimestamp(item.timestamp)}
          </span>
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono">{item.text}</pre>
      </div>
    </div>
  );
}

function AssistantItem({ item }: { item: Extract<ChatItem, { kind: 'assistant' }> }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] bg-muted/50 text-foreground rounded-lg px-4 py-2 w-full sm:w-auto">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase">Assistant</span>
          <span className="text-xs text-muted-foreground">
            {formatTimestamp(item.timestamp)}
          </span>
          {item.isStreaming && item.blocks.length === 0 && (
            <span className="inline-block w-2 h-4 bg-primary cursor-blink" />
          )}
        </div>
        <div className="space-y-2">
          {item.blocks.map((block, i) =>
            block.type === 'thinking' ? (
              <ThinkingBlock key={i} block={block} />
            ) : (
              <TextBlock key={i} block={block} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function TextBlock({ block }: { block: Extract<ContentBlock, { type: 'text' }> }) {
  return (
    <pre className="text-sm whitespace-pre-wrap font-mono">
      {block.text}
      {block.isStreaming && (
        <span className="inline-block w-2 h-4 bg-primary cursor-blink ml-0.5" />
      )}
    </pre>
  );
}

function ThinkingBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'thinking' }>;
}) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer flex items-center gap-1 select-none">
        <Brain className="w-3 h-3" />
        Thinking
        {block.isStreaming && <span className="animate-pulse ml-1">...</span>}
      </summary>
      <pre className="whitespace-pre-wrap pl-4 mt-1 border-l-2 border-border italic">
        {block.text}
        {block.isStreaming && (
          <span className="inline-block w-2 h-3 bg-muted-foreground cursor-blink ml-0.5" />
        )}
      </pre>
    </details>
  );
}

function ToolItem({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(item.status === 'error');

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] bg-card border border-border rounded-lg px-3 py-2 w-full sm:w-auto">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs w-full text-left"
        >
          {item.status === 'running' && (
            <Loader2 className="w-3 h-3 animate-spin text-warning shrink-0" />
          )}
          {item.status === 'success' && (
            <Check className="w-3 h-3 text-success shrink-0" />
          )}
          {item.status === 'error' && <X className="w-3 h-3 text-error shrink-0" />}
          <Wrench className="w-3 h-3 text-primary shrink-0" />
          <span className="font-semibold">{item.toolName}</span>
          <span className="text-muted-foreground truncate">{argsSummary(item.args)}</span>
        </button>
        {expanded && (
          <div className="mt-2 text-xs space-y-2">
            <div>
              <div className="text-muted-foreground mb-1">args:</div>
              <pre className="bg-muted/30 p-2 rounded font-mono whitespace-pre-wrap text-xs overflow-x-auto">
                {safeStringify(item.args)}
              </pre>
            </div>
            {item.result !== undefined && (
              <div>
                <div className="text-muted-foreground mb-1">result:</div>
                <pre
                  className={cn(
                    'p-2 rounded font-mono whitespace-pre-wrap text-xs overflow-x-auto',
                    item.isError ? 'bg-error/10 text-error' : 'bg-muted/30'
                  )}
                >
                  {formatResult(item.result)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SystemItem({ item }: { item: Extract<ChatItem, { kind: 'system' }> }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] bg-warning/10 border border-warning/30 text-warning rounded-lg px-4 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase">System</span>
          <span className="text-xs text-muted-foreground">
            {formatTimestamp(item.timestamp)}
          </span>
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono">{item.text}</pre>
      </div>
    </div>
  );
}

// ----- formatting helpers -----

function argsSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  const firstKey = Object.keys(obj)[0];
  if (!firstKey) return '';
  const v = obj[firstKey];
  const s = typeof v === 'string' ? v : safeStringify(v);
  return `${firstKey}: ${s.slice(0, 60)}${s.length > 60 ? '…' : ''}`;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(r.content)) {
      return r.content
        .map((c) => (c.type === 'text' && c.text ? c.text : safeStringify(c)))
        .join('\n');
    }
  }
  return safeStringify(result);
}
