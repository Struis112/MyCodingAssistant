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
