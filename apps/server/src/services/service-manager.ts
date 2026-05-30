// Service Manager
// Manages microservice lifecycle: spawn, monitor, restart, stop

import { EventEmitter } from 'events';

export interface ServiceConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  autoRestart?: boolean;
  maxRestarts?: number;
  restartDelayMs?: number;
}

export interface ServiceStatus {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  uptime?: number;
  restartCount: number;
  lastError?: string;
  enabled: boolean;
  cpu?: number;
  memory?: number;
}

export class ServiceManager extends EventEmitter {
  private services = new Map<string, ServiceStatus>();
  private configs = new Map<string, ServiceConfig>();

  constructor() {
    super();
    // Register default services
    this.registerService({
      name: 'llm-service',
      command: 'node',
      args: ['--experimental-vm-modules', 'dist/services/llm-worker.js'],
      autoRestart: true,
      maxRestarts: 5,
      restartDelayMs: 2000,
    });

    this.registerService({
      name: 'tts-service',
      command: 'node',
      args: ['dist/services/tts-worker.js'],
      autoRestart: true,
      maxRestarts: 3,
      restartDelayMs: 3000,
    });

    this.registerService({
      name: 'stt-service',
      command: 'node',
      args: ['dist/services/stt-worker.js'],
      autoRestart: true,
      maxRestarts: 3,
      restartDelayMs: 3000,
    });

    this.registerService({
      name: 'face-detection',
      command: 'node',
      args: ['dist/services/face-detection-worker.js'],
      autoRestart: true,
      maxRestarts: 3,
      restartDelayMs: 2000,
    });

    this.registerService({
      name: 'object-detection',
      command: 'node',
      args: ['dist/services/object-detection-worker.js'],
      autoRestart: true,
      maxRestarts: 3,
      restartDelayMs: 2000,
    });

    this.registerService({
      name: 'avatar-3d',
      command: 'node',
      args: ['dist/services/avatar-worker.js'],
      autoRestart: true,
      maxRestarts: 3,
      restartDelayMs: 2000,
    });
  }

  registerService(config: ServiceConfig): void {
    this.configs.set(config.name, config);
    this.services.set(config.name, {
      name: config.name,
      status: 'stopped',
      restartCount: 0,
      enabled: false,
    });
  }

  getStatus(): ServiceStatus[] {
    return Array.from(this.services.values());
  }

  getServiceStatus(name: string): ServiceStatus | undefined {
    return this.services.get(name);
  }

  async startService(name: string): Promise<void> {
    const config = this.configs.get(name);
    const status = this.services.get(name);
    if (!config || !status) throw new Error(`Unknown service: ${name}`);

    status.status = 'starting';
    status.enabled = true;
    this.emit('service:status', { name, status: 'starting' });

    // TODO: Actually spawn the process
    // For now, simulate a running service
    setTimeout(() => {
      status.status = 'running';
      status.pid = Math.floor(Math.random() * 10000);
      this.emit('service:status', { name, status: 'running' });
    }, 500);
  }

  async stopService(name: string): Promise<void> {
    const status = this.services.get(name);
    if (!status) throw new Error(`Unknown service: ${name}`);

    status.status = 'stopping';
    this.emit('service:status', { name, status: 'stopping' });

    // TODO: Actually kill the process
    setTimeout(() => {
      status.status = 'stopped';
      status.pid = undefined;
      status.enabled = false;
      this.emit('service:status', { name, status: 'stopped' });
    }, 300);
  }

  async restartService(name: string): Promise<void> {
    await this.stopService(name);
    await this.startService(name);
  }

  async enableService(name: string): Promise<void> {
    await this.startService(name);
  }

  async disableService(name: string): Promise<void> {
    await this.stopService(name);
  }

  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.services.keys()).map((name) =>
      this.stopService(name).catch(() => {})
    );
    await Promise.all(promises);
  }
}
