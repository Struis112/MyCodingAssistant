'use client';

import { useEffect } from 'react';
import { useAppStore, ServiceStatus } from '@/lib/store';
import { getSocket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import {
  Activity,
  Play,
  Square,
  RefreshCw,
  Cpu,
  MemoryStick,
  Clock,
  AlertCircle,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';

const statusColors: Record<ServiceStatus['status'], string> = {
  stopped: 'text-muted-foreground',
  starting: 'text-warning',
  running: 'text-success',
  stopping: 'text-warning',
  error: 'text-error',
};

const statusIcons: Record<ServiceStatus['status'], React.ReactNode> = {
  stopped: <XCircle className="w-4 h-4" />,
  starting: <Loader2 className="w-4 h-4 animate-spin" />,
  running: <CheckCircle className="w-4 h-4" />,
  stopping: <Loader2 className="w-4 h-4 animate-spin" />,
  error: <AlertCircle className="w-4 h-4" />,
};

export function Dashboard() {
  const { services, setServices, updateService } = useAppStore();

  useEffect(() => {
    const socket = getSocket();

    socket.on('services:status', (data: ServiceStatus[]) => {
      setServices(data);
    });

    socket.on('services:update', (data: { name: string; status: string }) => {
      updateService(data.name, { status: data.status as ServiceStatus['status'] });
    });

    // Request initial status
    socket.emit('services:list');

    return () => {
      socket.off('services:status');
      socket.off('services:update');
    };
  }, [setServices, updateService]);

  const handleStart = (name: string) => {
    getSocket().emit('services:start', { name });
  };

  const handleStop = (name: string) => {
    getSocket().emit('services:stop', { name });
  };

  const runningCount = services.filter((s) => s.status === 'running').length;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="h-12 border-b border-border flex items-center px-4 gap-3">
        <Activity className="w-5 h-5 text-primary" />
        <h1 className="text-sm font-semibold text-foreground">Service Dashboard</h1>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {runningCount}/{services.length} services running
        </span>
      </header>

      {/* Services grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map((service) => (
            <ServiceCard
              key={service.name}
              service={service}
              onStart={() => handleStart(service.name)}
              onStop={() => handleStop(service.name)}
            />
          ))}

          {services.length === 0 && (
            <div className="col-span-full flex flex-col items-center justify-center h-64 text-muted-foreground">
              <Activity className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-sm">No services registered</p>
              <p className="text-xs mt-2">Services will appear here when the server starts</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ServiceCard({
  service,
  onStart,
  onStop,
}: {
  service: ServiceStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  const isRunning = service.status === 'running';
  const isTransitioning = service.status === 'starting' || service.status === 'stopping';

  return (
    <div
      className={cn(
        'border rounded-lg p-4 transition-colors bg-card',
        isRunning ? 'border-success/30' : 'border-border'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={statusColors[service.status]}>{statusIcons[service.status]}</span>
          <h3 className="text-sm font-semibold text-card-foreground">{service.name}</h3>
        </div>
        <span className={cn('text-xs capitalize', statusColors[service.status])}>
          {service.status}
        </span>
      </div>

      {/* Stats */}
      <div className="space-y-2 mb-4">
        {service.pid && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu className="w-3 h-3" />
            <span>PID: {service.pid}</span>
          </div>
        )}
        {service.uptime && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="w-3 h-3" />
            <span>Uptime: {formatUptime(service.uptime)}</span>
          </div>
        )}
        {service.memory && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MemoryStick className="w-3 h-3" />
            <span>Memory: {formatBytes(service.memory)}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3" />
          <span>Restarts: {service.restartCount}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {isRunning ? (
          <button
            onClick={onStop}
            disabled={isTransitioning}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-error/20 text-error rounded hover:bg-error/30 disabled:opacity-50 transition-colors"
            aria-label={`Stop ${service.name}`}
          >
            <Square className="w-3 h-3" />
            Stop
          </button>
        ) : (
          <button
            onClick={onStart}
            disabled={isTransitioning}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-success/20 text-success rounded hover:bg-success/30 disabled:opacity-50 transition-colors"
            aria-label={`Start ${service.name}`}
          >
            <Play className="w-3 h-3" />
            Start
          </button>
        )}
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
