'use client';

import { useState, useEffect, useRef } from 'react';
import { getSocket } from '@/lib/socket';
import { ScrollText, Filter, Pause, Play, Trash2 } from 'lucide-react';

interface LogEntry {
  timestamp: number;
  service: string;
  level: 'info' | 'error' | 'warn';
  message: string;
}

export function LogsViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = getSocket();

    const handleLog = (log: { service: string; level: string; message: string }) => {
      if (isPaused) return;

      const entry: LogEntry = {
        timestamp: Date.now(),
        service: log.service,
        level: log.level as 'info' | 'error' | 'warn',
        message: log.message,
      };

      setLogs((prev) => [...prev.slice(-500), entry]); // Keep last 500 logs
    };

    socket.on('service:log', handleLog);

    return () => {
      socket.off('service:log', handleLog);
    };
  }, [isPaused]);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((log) => {
    if (filter === 'all') return true;
    if (filter === 'info') return log.level === 'info';
    if (filter === 'error') return log.level === 'error';
    if (filter === 'warn') return log.level === 'warn';
    return log.service === filter;
  });

  const services = Array.from(new Set(logs.map((log) => log.service)));

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error':
        return 'text-error';
      case 'warn':
        return 'text-warning';
      default:
        return 'text-foreground';
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <ScrollText className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">Service Logs</h2>
          <span className="text-xs text-muted-foreground ml-2">
            ({filteredLogs.length} entries)
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Filter dropdown */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="px-3 py-1 text-sm bg-muted border border-border rounded-lg text-foreground focus:outline-none focus:border-primary"
            >
              <option value="all">All Services</option>
              <option value="info">Info Only</option>
              <option value="warn">Warnings</option>
              <option value="error">Errors Only</option>
              {services.map((service) => (
                <option key={service} value={service}>
                  {service}
                </option>
              ))}
            </select>
          </div>

          {/* Pause/Resume */}
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`px-3 py-1 text-sm rounded-lg transition-colors flex items-center gap-1 ${
              isPaused
                ? 'bg-warning/20 text-warning hover:bg-warning/30'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
            title={isPaused ? 'Resume logs' : 'Pause logs'}
          >
            {isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            {isPaused ? 'Resume' : 'Pause'}
          </button>

          {/* Clear */}
          <button
            onClick={() => setLogs([])}
            className="px-3 py-1 text-sm bg-muted text-muted-foreground rounded-lg hover:bg-muted/80 transition-colors flex items-center gap-1"
            title="Clear logs"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        </div>
      </div>

      {/* Logs container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs bg-muted/10"
        onScroll={() => {
          if (!containerRef.current) return;
          const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
          const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
          setAutoScroll(isAtBottom);
        }}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>No logs yet. Logs will appear here as services run.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredLogs.map((log, i) => (
              <div key={i} className="flex gap-2 hover:bg-muted/20 px-2 py-1 rounded">
                <span className="text-muted-foreground shrink-0">{formatTime(log.timestamp)}</span>
                <span className="text-primary shrink-0 w-32 truncate">[{log.service}]</span>
                <span className={`shrink-0 w-12 ${getLevelColor(log.level)}`}>
                  {log.level.toUpperCase()}
                </span>
                <span className="text-foreground break-all">{log.message}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between p-3 border-t border-border bg-muted/5">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Auto-scroll: {autoScroll ? 'On' : 'Off'}</span>
          <span>Status: {isPaused ? 'Paused' : 'Live'}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Showing {filteredLogs.length} of {logs.length} logs
        </div>
      </div>
    </div>
  );
}
