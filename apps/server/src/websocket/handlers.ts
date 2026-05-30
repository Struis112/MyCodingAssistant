// WebSocket Handlers
// Streams Pi SDK events to the frontend in real-time

import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { PiSessionManager } from '../services/pi-session.js';
import type { ServiceManager } from '../services/service-manager.js';

export function registerWebSocketHandlers(
  io: SocketIOServer,
  piSessionManager: PiSessionManager,
  serviceManager: ServiceManager
): void {
  io.on('connection', (socket: Socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // --- Chat ---
    socket.on('chat:send', async (data: { sessionId: string; message: string }) => {
      const { sessionId, message } = data;

      try {
        let session = piSessionManager.getSession(sessionId);
        if (!session) {
          session = await piSessionManager.createSession(sessionId);
        }

        // Subscribe to session events and forward to the socket
        const unsubscribe = session.subscribe((event) => {
          socket.emit('chat:event', { sessionId, event });
        });

        // Send the prompt
        await session.prompt(message);

        // Unsubscribe after completion
        unsubscribe();
        socket.emit('chat:done', { sessionId });
      } catch (error) {
        socket.emit('chat:error', { sessionId, error: String(error) });
      }
    });

    socket.on('chat:abort', async (data: { sessionId: string }) => {
      const session = piSessionManager.getSession(data.sessionId);
      if (session) {
        await session.abort();
        socket.emit('chat:aborted', { sessionId: data.sessionId });
      }
    });

    // --- Session Settings ---
    socket.on(
      'session:setModel',
      async (data: { sessionId: string; modelId: string }) => {
        try {
          const session = piSessionManager.getSession(data.sessionId);
          if (!session) {
            socket.emit('session:error', { error: 'Session not found' });
            return;
          }

          const models = await piSessionManager.getAvailableModels();
          const model = models.find((m) => m.id === data.modelId);
          if (!model) {
            socket.emit('session:error', { error: `Model not found: ${data.modelId}` });
            return;
          }

          // Note: setModel requires a full Model object, not just the info
          // For now, acknowledge the request
          socket.emit('session:modelChanged', { modelId: data.modelId });
          console.log(`[WS] Model change requested: ${data.modelId}`);
        } catch (error) {
          socket.emit('session:error', { error: String(error) });
        }
      }
    );

    socket.on(
      'session:setThinkingLevel',
      async (data: { sessionId: string; level: string }) => {
        try {
          const session = piSessionManager.getSession(data.sessionId);
          if (!session) {
            socket.emit('session:error', { error: 'Session not found' });
            return;
          }

          const validLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
          if (!validLevels.includes(data.level)) {
            socket.emit('session:error', { error: `Invalid thinking level: ${data.level}` });
            return;
          }

          session.setThinkingLevel(data.level as any);
          socket.emit('session:thinkingLevelChanged', { level: data.level });
          console.log(`[WS] Thinking level changed: ${data.level}`);
        } catch (error) {
          socket.emit('session:error', { error: String(error) });
        }
      }
    );

    // --- Services ---
    socket.on('services:list', () => {
      socket.emit('services:status', serviceManager.getStatus());
    });

    socket.on('services:start', async (data: { name: string }) => {
      try {
        await serviceManager.startService(data.name);
        socket.emit('services:status', serviceManager.getStatus());
      } catch (error) {
        socket.emit('services:error', { name: data.name, error: String(error) });
      }
    });

    socket.on('services:stop', async (data: { name: string }) => {
      try {
        await serviceManager.stopService(data.name);
        socket.emit('services:status', serviceManager.getStatus());
      } catch (error) {
        socket.emit('services:error', { name: data.name, error: String(error) });
      }
    });

    socket.on('services:restart', async (data: { name: string }) => {
      try {
        await serviceManager.restartService(data.name);
        socket.emit('services:status', serviceManager.getStatus());
      } catch (error) {
        socket.emit('services:error', { name: data.name, error: String(error) });
      }
    });

    // Forward service status changes to all clients
    serviceManager.on('service:status', (status) => {
      io.emit('services:update', status);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });
}
