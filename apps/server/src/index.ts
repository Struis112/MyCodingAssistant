// MyCodingAssistant Server - Entry point
// Integrates Pi SDK via WebSocket + REST API

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { PiSessionManager } from './services/pi-session.js';
import { ServiceManager } from './services/service-manager.js';
import { registerApiRoutes } from './api/routes.js';
import { registerWebSocketHandlers } from './websocket/handlers.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Express app
const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

// HTTP server
const httpServer = createServer(app);

// WebSocket server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

// Core services
const serviceManager = new ServiceManager();
const piSessionManager = new PiSessionManager();

// Register microservices
serviceManager.registerService({
  name: 'llm-service',
  script: 'dist/services/llm-worker.js',
  healthEndpoint: '/health',
  restart: true,
  maxRestarts: 5,
  restartDelay: 2000,
});

serviceManager.registerService({
  name: 'tts-service',
  script: 'dist/services/tts-worker.js',
  healthEndpoint: '/health',
  restart: true,
  maxRestarts: 3,
  restartDelay: 2000,
});

serviceManager.registerService({
  name: 'stt-service',
  script: 'dist/services/stt-worker.js',
  healthEndpoint: '/health',
  restart: true,
  maxRestarts: 3,
  restartDelay: 2000,
});

serviceManager.registerService({
  name: 'face-detection',
  script: 'dist/services/face-detection-worker.js',
  healthEndpoint: '/health',
  restart: true,
  maxRestarts: 3,
  restartDelay: 3000,
});

serviceManager.registerService({
  name: 'object-detection',
  script: 'dist/services/object-detection-worker.js',
  healthEndpoint: '/health',
  restart: true,
  maxRestarts: 3,
  restartDelay: 3000,
});

serviceManager.registerService({
  name: 'avatar-3d',
  script: 'dist/services/avatar-worker.js',
  healthEndpoint: '/health',
  restart: true,
  maxRestarts: 3,
  restartDelay: 2000,
});

// Auto-start services that are configured to restart
// (gives the user a running system out of the box)
async function autoStartServices() {
  const servicesToStart = [
    'llm-service',
    'tts-service',
    'stt-service',
    'face-detection',
    'object-detection',
    'avatar-3d',
  ];

  for (const name of servicesToStart) {
    try {
      await serviceManager.startService(name);
      console.log(`[MCA Server] Started ${name}`);
    } catch (err: any) {
      console.warn(`[MCA Server] Could not auto-start ${name}: ${err.message}`);
    }
  }
}

// Forward service logs to connected WebSocket clients
serviceManager.on('service:log', (log: { name: string; level: string; message: string }) => {
  io.emit('service:log', log);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: serviceManager.getStatus(),
  });
});

// Register routes
registerApiRoutes(app, piSessionManager, serviceManager);
registerWebSocketHandlers(io, piSessionManager, serviceManager);

// Start server
httpServer.listen(PORT, HOST, () => {
  console.log(`[MCA Server] Running on http://${HOST}:${PORT}`);
  console.log('[MCA Server] WebSocket ready for frontend connections');
  autoStartServices();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[MCA Server] Shutting down...');
  await serviceManager.shutdownAll();
  piSessionManager.disposeAll();
  httpServer.close(() => {
    console.log('[MCA Server] Stopped');
    process.exit(0);
  });
});
