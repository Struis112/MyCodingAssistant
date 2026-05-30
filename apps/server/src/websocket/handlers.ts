// WebSocket Handlers
// Bridges the Pi SDK agent session to the browser via socket.io.
// Every AgentSessionEvent that the SDK emits is forwarded as `chat:event`
// so the frontend can render text deltas, thinking blocks, tool calls, etc.

import type { Server as SocketIOServer, Socket } from "socket.io";
import type { PiSessionManager } from "../services/pi-session.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// Per-session unsubscribers so we can clean up when the same session is sent
// multiple prompts.
const eventSubscribers = new Map<string, () => void>();

function attachEventForwarder(io: SocketIOServer, piSessionManager: PiSessionManager, sessionId: string): void {
  if (eventSubscribers.has(sessionId)) return;
  const session = piSessionManager.getSession(sessionId);
  if (!session) return;

  const unsubscribe = session.subscribe((event) => {
    // Broadcast to all sockets so a reloaded tab still receives events for
    // its session. In practice we expect one tab, but this is the right default.
    io.emit("chat:event", { sessionId, event });
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

export function registerWebSocketHandlers(io: SocketIOServer, piSessionManager: PiSessionManager): void {
  io.on("connection", (socket: Socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // ----- Chat -----

    socket.on(
      "chat:send",
      async (data: {
        sessionId: string;
        message: string;
        /**
         * Optional queue behavior when the agent is already streaming.
         * 'steer' (default): delivered after the current assistant turn finishes
         *                    executing its tool calls, before the next LLM call.
         * 'followUp':       delivered when the agent has no more work pending.
         * Ignored if the agent is idle (message is sent as a fresh prompt).
         */
        behavior?: "steer" | "followUp";
      }) => {
        const { sessionId, message, behavior } = data;
        console.log(`[WS] chat:send sid=${sessionId} len=${message?.length ?? 0} from=${socket.id}`);
        try {
          await piSessionManager.getOrCreateSession(sessionId);
          attachEventForwarder(io, piSessionManager, sessionId);
          const session = piSessionManager.getSession(sessionId)!;

          if (session.isStreaming) {
            const mode: "steer" | "followUp" = behavior === "followUp" ? "followUp" : "steer";
            if (mode === "followUp") await session.followUp(message);
            else await session.steer(message);
            io.emit("chat:queued", { sessionId, behavior: mode });
            return;
          }

          await session.prompt(message);
          io.emit("chat:done", { sessionId });
          console.log(`[WS] chat:done sid=${sessionId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[WS] chat:send FAILED sid=${sessionId}:`, msg);
          io.emit("chat:error", { sessionId, error: msg });
          io.emit("chat:done", { sessionId });
        }
      },
    );

    socket.on("chat:abort", async (data: { sessionId: string }) => {
      console.log(`[WS] chat:abort sid=${data.sessionId} from=${socket.id}`);
      const session = piSessionManager.getSession(data.sessionId);
      if (session) {
        try {
          await session.abort();
          io.emit("chat:aborted", { sessionId: data.sessionId });
          io.emit("chat:done", { sessionId: data.sessionId });
        } catch (err) {
          io.emit("chat:error", { sessionId: data.sessionId, error: String(err) });
          io.emit("chat:done", { sessionId: data.sessionId });
        }
      } else {
        io.emit("chat:done", { sessionId: data.sessionId });
      }
    });

    socket.on("chat:new", async (data: { sessionId: string }) => {
      try {
        detachEventForwarder(data.sessionId);
        await piSessionManager.newSession(data.sessionId);
        attachEventForwarder(io, piSessionManager, data.sessionId);
        const session = piSessionManager.getSession(data.sessionId)!;
        io.emit("chat:new", {
          sessionId: data.sessionId,
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
        });
      } catch (err) {
        io.emit("chat:error", { sessionId: data.sessionId, error: String(err) });
      }
    });

    socket.on("chat:resume", async (data: { sessionId: string; sessionFile: string }) => {
      try {
        detachEventForwarder(data.sessionId);
        await piSessionManager.resumeSession(data.sessionId, data.sessionFile);
        attachEventForwarder(io, piSessionManager, data.sessionId);
        const session = piSessionManager.getSession(data.sessionId)!;
        io.emit("chat:resumed", {
          sessionId: data.sessionId,
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
          messages: session.messages,
        });
      } catch (err) {
        io.emit("chat:error", { sessionId: data.sessionId, error: String(err) });
      }
    });

    socket.on("chat:list", async () => {
      try {
        const sessions = await piSessionManager.listPersistedSessions();
        socket.emit("chat:sessions", sessions);
      } catch (err) {
        socket.emit("chat:error", { sessionId: "", error: String(err) });
      }
    });

    socket.on("chat:state", (data: { sessionId: string }) => {
      const session = piSessionManager.getSession(data.sessionId);
      if (!session) {
        socket.emit("chat:state:result", { sessionId: data.sessionId, state: null });
        return;
      }
      socket.emit("chat:state:result", {
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

    socket.on("session:setModel", async (data: { sessionId: string; provider: string; modelId: string }) => {
      try {
        await piSessionManager.getOrCreateSession(data.sessionId);
        const model = await piSessionManager.setSessionModel(data.sessionId, data.provider, data.modelId);
        io.emit("session:modelChanged", { sessionId: data.sessionId, model });
        console.log(`[WS] Model set: ${data.provider}/${data.modelId}`);
      } catch (err) {
        socket.emit("session:error", { error: String(err) });
      }
    });

    socket.on("session:setThinkingLevel", async (data: { sessionId: string; level: ThinkingLevel }) => {
      try {
        await piSessionManager.getOrCreateSession(data.sessionId);
        piSessionManager.setSessionThinkingLevel(data.sessionId, data.level);
        io.emit("session:thinkingLevelChanged", {
          sessionId: data.sessionId,
          level: data.level,
        });
      } catch (err) {
        socket.emit("session:error", { error: String(err) });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });
}
