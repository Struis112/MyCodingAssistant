// Service Worker Base Template
// All microservices should extend this pattern.
// Each service runs as an independent Node.js process
// with a health endpoint for monitoring.

import http from 'http';

const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown';
const SERVICE_PORT = parseInt(process.env.SERVICE_PORT || '0', 10);

interface ServiceHealth {
  name: string;
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  timestamp: string;
  details?: Record<string, any>;
}

// Base service class that all workers should extend
export class ServiceWorker {
  protected name: string;
  protected port: number;
  protected server?: http.Server;
  protected startTime: number;
  protected healthDetails: Record<string, any> = {};

  constructor() {
    this.name = SERVICE_NAME;
    this.port = SERVICE_PORT;
    this.startTime = Date.now();
  }

  // Override in subclass to do initialization work
  async initialize(): Promise<void> {
    // Default: no-op
  }

  // Override in subclass to do cleanup work
  async shutdown(): Promise<void> {
    // Default: no-op
  }

  // Override in subclass to add custom health details
  getHealthDetails(): Record<string, any> {
    return this.healthDetails;
  }

  // Health endpoint response
  getHealth(): ServiceHealth {
    return {
      name: this.name,
      status: 'ok',
      uptime: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
      details: this.getHealthDetails(),
    };
  }

  // Start the health HTTP server
  async start(): Promise<void> {
    await this.initialize();

    if (this.port > 0) {
      this.server = http.createServer((req, res) => {
        if (req.url === '/health' && req.method === 'GET') {
          const health = this.getHealth();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      await new Promise<void>((resolve) => {
        this.server!.listen(this.port, () => {
          console.log(`[${this.name}] Health server listening on port ${this.port}`);
          resolve();
        });
      });
    } else {
      console.log(`[${this.name}] No port assigned, running without health server`);
    }

    // Graceful shutdown handlers
    process.on('SIGTERM', async () => {
      console.log(`[${this.name}] Received SIGTERM, shutting down...`);
      await this.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log(`[${this.name}] Received SIGINT, shutting down...`);
      await this.stop();
      process.exit(0);
    });

    process.on('uncaughtException', (err) => {
      console.error(`[${this.name}] Uncaught exception:`, err);
    });

    process.on('unhandledRejection', (reason) => {
      console.error(`[${this.name}] Unhandled rejection:`, reason);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
    await this.shutdown();
    console.log(`[${this.name}] Stopped`);
  }
}

// Example: how to create a service worker
//
// import { ServiceWorker } from './service-worker-base.js';
//
// class LLMPerviceWorker extends ServiceWorker {
//   private modelLoaded = false;
//
//   async initialize(): Promise<void> {
//     // Load model, set up resources
//     console.log(`[${this.name}] Loading LLM model...`);
//     this.modelLoaded = true;
//     this.healthDetails.modelLoaded = true;
//   }
//
//   async shutdown(): Promise<void> {
//     // Cleanup
//     console.log(`[${this.name}] Unloading model...`);
//   }
//
//   getHealthDetails(): Record<string, any> {
//     return { modelLoaded: this.modelLoaded };
//   }
// }
//
// const worker = new LLMPerviceWorker();
// worker.start().catch(console.error);
