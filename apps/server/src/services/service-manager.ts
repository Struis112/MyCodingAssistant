// Service Manager
// Manages microservice lifecycle: spawn, monitor, restart, stop

import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';

export interface ServiceConfig {
  name: string;
  script: string;
  port?: number;
  healthEndpoint?: string;
  env?: Record<string, string>;
  restart?: boolean;
  maxRestarts?: number;
  restartDelay?: number;
}

export interface ServiceStatus {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  pid?: number;
  uptime?: number;
  restartCount: number;
  lastError?: string;
  enabled: boolean;
  port?: number;
  cpu?: number;
  memory?: number;
}

interface ServiceInstance {
  config: ServiceConfig;
  status: ServiceStatus;
  process?: ChildProcess;
  startTime?: number;
  healthCheckInterval?: NodeJS.Timeout;
}

export class ServiceManager extends EventEmitter {
  private services = new Map<string, ServiceInstance>();
  private portAllocator: PortAllocator;

  constructor() {
    super();
    this.portAllocator = new PortAllocator(9000);
  }

  registerService(config: ServiceConfig): void {
    if (this.services.has(config.name)) {
      throw new Error(`Service ${config.name} already registered`);
    }

    const instance: ServiceInstance = {
      config,
      status: {
        name: config.name,
        status: 'stopped',
        restartCount: 0,
        enabled: false,
      },
    };

    this.services.set(config.name, instance);
    this.emit('service:registered', config.name);
  }

  getStatus(): ServiceStatus[] {
    return Array.from(this.services.values()).map((s) => s.status);
  }

  getServiceStatus(name: string): ServiceStatus | undefined {
    return this.services.get(name)?.status;
  }

  async startService(name: string): Promise<void> {
    const instance = this.services.get(name);
    if (!instance) throw new Error(`Unknown service: ${name}`);

    if (instance.status.status === 'running') {
      return; // Already running
    }

    instance.status.status = 'starting';
    instance.status.enabled = true;
    this.emit('service:status', { name, status: 'starting' });

    try {
      // Allocate port if needed
      if (instance.config.port === undefined) {
        instance.config.port = await this.portAllocator.allocate();
        instance.status.port = instance.config.port;
      }

      // Spawn process
      const env = {
        ...process.env,
        ...instance.config.env,
        SERVICE_NAME: name,
        SERVICE_PORT: String(instance.config.port),
      };

      instance.process = spawn('node', [instance.config.script], {
        env,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      instance.startTime = Date.now();
      instance.status.pid = instance.process.pid;

      // Handle process output
      instance.process.stdout?.on('data', (data) => {
        this.emit('service:log', { name, level: 'info', message: data.toString() });
      });

      instance.process.stderr?.on('data', (data) => {
        this.emit('service:log', { name, level: 'error', message: data.toString() });
      });

      // Handle process exit
      instance.process.on('exit', (code) => {
        this.handleServiceExit(name, code);
      });

      instance.process.on('error', (err) => {
        instance.status.status = 'error';
        instance.status.lastError = err.message;
        this.emit('service:status', { name, status: 'error', error: err.message });
      });

      // Start health checks
      if (instance.config.healthEndpoint) {
        this.startHealthChecks(name);
      } else {
        // No health endpoint, assume running after spawn
        instance.status.status = 'running';
        this.emit('service:status', { name, status: 'running' });
      }
    } catch (err: any) {
      instance.status.status = 'error';
      instance.status.lastError = err.message;
      this.emit('service:status', { name, status: 'error', error: err.message });
      throw err;
    }
  }

  async stopService(name: string): Promise<void> {
    const instance = this.services.get(name);
    if (!instance) throw new Error(`Unknown service: ${name}`);

    if (instance.status.status === 'stopped') {
      return; // Already stopped
    }

    instance.status.status = 'stopping';
    this.emit('service:status', { name, status: 'stopping' });

    // Stop health checks
    if (instance.healthCheckInterval) {
      clearInterval(instance.healthCheckInterval);
      instance.healthCheckInterval = undefined;
    }

    // Kill process
    if (instance.process) {
      try {
        instance.process.kill('SIGTERM');
        
        // Force kill after 5 seconds
        const killTimeout = setTimeout(() => {
          if (instance.process && !instance.process.killed) {
            instance.process.kill('SIGKILL');
          }
        }, 5000);

        instance.process.once('exit', () => {
          clearTimeout(killTimeout);
        });
      } catch (err: any) {
        // Process may already be dead
      }
    }

    // Release port
    if (instance.config.port) {
      this.portAllocator.release(instance.config.port);
      instance.config.port = undefined;
    }

    instance.status.status = 'stopped';
    instance.status.pid = undefined;
    instance.status.uptime = undefined;
    instance.status.enabled = false;
    instance.process = undefined;
    instance.startTime = undefined;

    this.emit('service:status', { name, status: 'stopped' });
  }

  async restartService(name: string): Promise<void> {
    await this.stopService(name);
    await new Promise((resolve) => setTimeout(resolve, 100));
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

  private handleServiceExit(name: string, code: number | null): void {
    const instance = this.services.get(name);
    if (!instance) return;

    // Clear health checks
    if (instance.healthCheckInterval) {
      clearInterval(instance.healthCheckInterval);
      instance.healthCheckInterval = undefined;
    }

    // Release port
    if (instance.config.port) {
      this.portAllocator.release(instance.config.port);
      instance.config.port = undefined;
    }

    instance.status.pid = undefined;
    instance.process = undefined;
    instance.startTime = undefined;

    // Check if we should restart
    const shouldRestart =
      instance.config.restart &&
      instance.status.enabled &&
      instance.status.restartCount < (instance.config.maxRestarts || 3) &&
      instance.status.status !== 'stopping';

    if (shouldRestart) {
      instance.status.restartCount++;
      instance.status.status = 'error';
      instance.status.lastError = `Process exited with code ${code}`;
      this.emit('service:status', { name, status: 'error', error: instance.status.lastError });

      // Restart with exponential backoff
      const delay = (instance.config.restartDelay || 1000) * Math.pow(2, instance.status.restartCount - 1);
      setTimeout(() => {
        if (instance.status.enabled) {
          this.startService(name).catch((err) => {
            instance.status.status = 'error';
            instance.status.lastError = err.message;
            this.emit('service:status', { name, status: 'error', error: err.message });
          });
        }
      }, delay);
    } else {
      instance.status.status = 'stopped';
      instance.status.enabled = false;
      this.emit('service:status', { name, status: 'stopped' });
    }
  }

  private startHealthChecks(name: string): void {
    const instance = this.services.get(name);
    if (!instance || !instance.config.healthEndpoint || !instance.config.port) return;

    const checkHealth = async () => {
      try {
        const response = await fetch(
          `http://localhost:${instance.config.port}${instance.config.healthEndpoint}`,
          { method: 'GET', signal: AbortSignal.timeout(2000) }
        );

        if (response.ok) {
          if (instance.status.status === 'starting') {
            instance.status.status = 'running';
            this.emit('service:status', { name, status: 'running' });
          }
          instance.status.uptime = instance.startTime ? Date.now() - instance.startTime : 0;
        } else {
          instance.status.status = 'error';
          instance.status.lastError = `Health check failed: ${response.status}`;
          this.emit('service:status', { name, status: 'error', error: instance.status.lastError });
        }
      } catch (err: any) {
        if (instance.status.status === 'starting') {
          // Still starting, don't mark as error yet
          return;
        }
        instance.status.status = 'error';
        instance.status.lastError = `Health check failed: ${err.message}`;
        this.emit('service:status', { name, status: 'error', error: instance.status.lastError });
      }
    };

    // Check immediately
    checkHealth();

    // Then check every 10 seconds
    instance.healthCheckInterval = setInterval(checkHealth, 10000);
  }
}

// Simple port allocator
class PortAllocator {
  private basePort: number;
  private allocated = new Set<number>();

  constructor(basePort: number) {
    this.basePort = basePort;
  }

  async allocate(): Promise<number> {
    let port = this.basePort;
    while (this.allocated.has(port)) {
      port++;
    }
    this.allocated.add(port);
    return port;
  }

  release(port: number): void {
    this.allocated.delete(port);
  }
}
