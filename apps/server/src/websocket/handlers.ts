// WebSocket Handlers
// Bridges the Pi SDK agent session to the browser via socket.io.
// Every AgentSessionEvent that the SDK emits is forwarded as `chat:event`
// so the frontend can render text deltas, thinking blocks, tool calls, etc.

import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { PiSessionManager } from '../services/pi-session.js';
import type { ServiceManager } from '../services/service-manager.js';

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Per-session unsubscribers so we can clean up when the same session is sent
// multiple prompts.
const eventSubscribers = new Map<string, () => void>();

function attachEventForwarder(
  io: SocketIOServer,
  piSessionManager: PiSessionManager,
  sessionId: string
): void {
  // Don't double-subscribe.
  if (eventSubscribers.has(sessionId)) return;

  const session = piSessionManager.getSession(sessionId);
  if (!session) return;

  const unsubscribe = session.subscribe((event) => {
    // Broadcast to all sockets so multiple browsers can observe the same
    // session. In practice we expect one tab, but this is the right default.
    io.emit('chat:event', { sessionId, event });
  });

  eventSubscribers.set(sessionId, unsubscribe);
}

function detachEventForwarder(sessionId: string): void {
  const unsubscribe = eventSubscribers.get(sessionId);
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* ignore */
    }
    eventSubscribers.delete(sessionId);
  }
}

export function registerWebSocketHandlers(
  io: SocketIOServer,
  piSessionManager: PiSessionManager,
  serviceManager: ServiceManager
): void {
  io.on('connection', (socket: Socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // ----- Chat -----

    socket.on('chat:send', async (data: { sessionId: string; message: string }) => {
      const { sessionId, message } = data;
      try {
        await piSessionManager.getOrCreateSession(sessionId);
        attachEventForwarder(io, piSessionManager, sessionId);
        const session = piSessionManager.getSession(sessionId)!;
        await session.prompt(message);
        socket.emit('chat:done', { sessionId });
      } catch (err) {
        socket.emit('chat:error', { sessionId, error: String(err) });
      }
    });

    socket.on('chat:abort', async (data: { sessionId: string }) => {
      const session = piSessionManager.getSession(data.sessionId);
      if (session) {
        try {
          await session.abort();
          socket.emit('chat:aborted', { sessionId: data.sessionId });
        } catch (err) {
          socket.emit('chat:error', { sessionId: data.sessionId, error: String(err) });
        }
      }
    });

    socket.on('chat:new', async (data: { sessionId: string }) => {
      try {
        detachEventForwarder(data.sessionId);
        await piSessionManager.newSession(data.sessionId);
        attachEventForwarder(io, piSessionManager, data.sessionId);
        const session = piSessionManager.getSession(data.sessionId)!;
        socket.emit('chat:new', {
          sessionId: data.sessionId,
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
        });
      } catch (err) {
        socket.emit('chat:error', { sessionId: data.sessionId, error: String(err) });
      }
    });

    socket.on(
      'chat:resume',
      async (data: { sessionId: string; sessionFile: string }) => {
        try {
          detachEventForwarder(data.sessionId);
          await piSessionManager.resumeSession(data.sessionId, data.sessionFile);
          attachEventForwarder(io, piSessionManager, data.sessionId);
          const session = piSessionManager.getSession(data.sessionId)!;
          // Send a snapshot of the resumed conversation so the UI rehydrates.
          socket.emit('chat:resumed', {
            sessionId: data.sessionId,
            sessionFile: session.sessionFile,
            piSessionId: session.sessionId,
            messages: session.messages,
          });
        } catch (err) {
          socket.emit('chat:error', { sessionId: data.sessionId, error: String(err) });
        }
      }
    );

    socket.on('chat:list', async () => {
      try {
        const sessions = await piSessionManager.listPersistedSessions();
        socket.emit('chat:sessions', sessions);
      } catch (err) {
        socket.emit('chat:error', { sessionId: '', error: String(err) });
      }
    });

    socket.on('chat:state', (data: { sessionId: string }) => {
      const session = piSessionManager.getSession(data.sessionId);
      if (!session) {
        socket.emit('chat:state:result', { sessionId: data.sessionId, state: null });
        return;
      }
      socket.emit('chat:state:result', {
        sessionId: data.sessionId,
        state: {
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
          model: session.model
            ? {
                id: session.model.id,
                name: session.model.name,
                provider: session.model.provider,
              }
            : null,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          messages: session.messages,
        },
      });
    });

    // ----- Session settings -----

    socket.on(
      'session:setModel',
      async (data: { sessionId: string; provider: string; modelId: string }) => {
        try {
          // Make sure a session exists so setModel has somewhere to land.
          await piSessionManager.getOrCreateSession(data.sessionId);
          const model = await piSessionManager.setSessionModel(
            data.sessionId,
            data.provider,
            data.modelId
          );
          socket.emit('session:modelChanged', {
            sessionId: data.sessionId,
            model,
          });
          console.log(`[WS] Model set: ${data.provider}/${data.modelId}`);
        } catch (err) {
          socket.emit('session:error', { error: String(err) });
        }
      }
    );

    socket.on(
      'session:setThinkingLevel',
      async (data: { sessionId: string; level: ThinkingLevel }) => {
        try {
          await piSessionManager.getOrCreateSession(data.sessionId);
          piSessionManager.setSessionThinkingLevel(data.sessionId, data.level);
          socket.emit('session:thinkingLevelChanged', {
            sessionId: data.sessionId,
            level: data.level,
          });
        } catch (err) {
          socket.emit('session:error', { error: String(err) });
        }
      }
    );

    // ----- Services -----

    socket.on('services:list', () => {
      socket.emit('services:status', serviceManager.getStatus());
    });

    socket.on('services:start', async (data: { name: string }) => {
      try {
        await serviceManager.startService(data.name);
        io.emit('services:status', serviceManager.getStatus());
      } catch (err) {
        socket.emit('services:error', { name: data.name, error: String(err) });
      }
    });

    socket.on('services:stop', async (data: { name: string }) => {
      try {
        await serviceManager.stopService(data.name);
        io.emit('services:status', serviceManager.getStatus());
      } catch (err) {
        socket.emit('services:error', { name: data.name, error: String(err) });
      }
    });

    socket.on('services:restart', async (data: { name: string }) => {
      try {
        await serviceManager.restartService(data.name);
        io.emit('services:status', serviceManager.getStatus());
      } catch (err) {
        socket.emit('services:error', { name: data.name, error: String(err) });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  // Forward service status changes to all clients
  serviceManager.on('service:status', (status) => {
    io.emit('services:update', status);
  });
}
