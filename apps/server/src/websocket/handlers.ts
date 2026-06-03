// WebSocket Handlers
// Bridges the Pi SDK agent session to the browser via socket.io.
// Every AgentSessionEvent that the SDK emits is forwarded as `chat:event`
// so the frontend can render text deltas, thinking blocks, tool calls, etc.
//
// Per-session room semantics
// --------------------------
// Every session-scoped event (chat:event, chat:done, chat:error, chat:queued,
// chat:aborted, chat:new, chat:resumed, session:modelChanged,
// session:thinkingLevelChanged) is delivered to the socket.io room
// `session:<sessionId>` instead of broadcast to every connected client.
// Sockets join their session room lazily on the first event they send for
// that session id. This keeps separate browser tabs / clients with different
// sessions cleanly isolated from each other.

import type { Server as SocketIOServer, Socket } from "socket.io";
import type { ConnectorManager, ThinkingLevel } from "../connectors/types.js";

// Per-session unsubscribers so we can clean up when the same session is sent
// multiple prompts.
const eventSubscribers = new Map<string, () => void>();

/** The socket.io room name a session lives in. */
function roomFor(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Subscribe a socket to a session's room (idempotent in socket.io). */
function joinSession(socket: Socket, sessionId: string): void {
  try {
    socket.join(roomFor(sessionId));
  } catch {
    /* tests may not implement join; ignore */
  }
}

function attachEventForwarder(
  io: SocketIOServer,
  piSessionManager: ConnectorManager,
  sessionId: string,
): void {
  if (eventSubscribers.has(sessionId)) return;
  const session = piSessionManager.getSession(sessionId);
  if (!session) return;

  // Per-turn diagnostic counters. Reset at every message_start so a quiet
  // turn (model returned 0 text/thinking content) is visible from the server
  // log alone — helpful when the UI shows an empty assistant bubble.
  let counts = { text: 0, thinking: 0, toolStart: 0, toolEnd: 0 };
  let inTurn = false;
  const debug = process.env.MCA_DEBUG_EVENTS === "1";

  const room = roomFor(sessionId);
  const unsubscribe = session.subscribe((event) => {
    // Only sockets that have joined this session's room receive its events.
    // A reloaded tab will re-join on its next chat:state, so it picks up
    // future events seamlessly.
    io.to(room).emit("chat:event", { sessionId, event });

    // ---- Diagnostics ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = event as any;
    if (debug) console.log(`[WS] event sid=${sessionId} type=${ev?.type}`);
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "message_start" && ev.message?.role === "assistant") {
      counts = { text: 0, thinking: 0, toolStart: 0, toolEnd: 0 };
      inTurn = true;
      return;
    }
    if (ev.type === "message_update") {
      const sub = ev.assistantMessageEvent?.type;
      if (sub === "text_delta") counts.text += 1;
      else if (sub === "thinking_delta") counts.thinking += 1;
      return;
    }
    if (ev.type === "tool_execution_start") counts.toolStart += 1;
    else if (ev.type === "tool_execution_end") counts.toolEnd += 1;
    else if (ev.type === "message_end" && inTurn) {
      inTurn = false;
      const empty = counts.text === 0 && counts.thinking === 0 && counts.toolStart === 0;
      if (empty) {
        // Look up the current model so the surfaced error is actionable.
        const current = piSessionManager.getSession(sessionId);
        const modelId = current?.model?.id ?? "<unset>";
        const provider = current?.model?.provider ?? "<unset>";
        const detail = `The model returned no content (0 text / 0 thinking / 0 tool events for this turn). Active model: ${provider}/${modelId}. This usually means the model id is a registry alias the upstream provider doesn't actually serve — try a different model in Settings.`;
        console.warn(`[WS] WARN sid=${sessionId} ${detail}`);
        // Tell the frontend so the user sees it in the chat as a system
        // item instead of staring at an empty assistant bubble.
        io.to(room).emit("chat:error", { sessionId, error: detail });
      } else if (debug) {
        console.log(
          `[WS] turn done sid=${sessionId} text=${counts.text} thinking=${counts.thinking} tools=${counts.toolStart}/${counts.toolEnd}`,
        );
      }
    }
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
  piSessionManager: ConnectorManager,
): void {
  io.on("connection", (socket: Socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // ----- Chat -----

    socket.on(
      "chat:send",
      async (data: {
        sessionId: string;
        message: string;
        /** Optional base64 image attachments (from frontend drag/drop). */
        images?: Array<{ data: string; mediaType: string }>;
        /**
         * Optional queue behavior when the agent is already streaming.
         * 'steer' (default): delivered after the current assistant turn finishes
         *                    executing its tool calls, before the next LLM call.
         * 'followUp':       delivered when the agent has no more work pending.
         * Ignored if the agent is idle (message is sent as a fresh prompt).
         */
        behavior?: "steer" | "followUp";
      }) => {
        const { sessionId, message, behavior, images } = data;
        const imgCount = images?.length ?? 0;
        console.log(
          `[WS] chat:send sid=${sessionId} len=${message?.length ?? 0} imgs=${imgCount} from=${socket.id}`,
        );
        joinSession(socket, sessionId);
        const room = roomFor(sessionId);
        try {
          await piSessionManager.getOrCreateSession(sessionId);
          attachEventForwarder(io, piSessionManager, sessionId);
          const session = piSessionManager.getSession(sessionId)!;

          // Pi SDK's ImageContent (from pi-ai/types.ts) is FLAT:
          //   { type: "image", data: string /* base64 */, mimeType: string }
          // Earlier code here built the Anthropic-raw shape
          //   { type: "image", source: { type: "base64", mediaType, data } }
          // which the SDK silently drops — every image attachment ever sent
          // through this chat produced a 0-event empty assistant turn. Use
          // the documented flat shape; cast to `any` to avoid pulling the
          // SDK's narrow MediaType union (which would reject arbitrary mime
          // strings users could drop in).
          const sdkImages = (images || []).map((img) => ({
            type: "image",
            data: img.data,
            mimeType: img.mediaType,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          })) as any;

          if (session.isStreaming) {
            // While streaming, images can't be attached to a queued message;
            // tell the user if they tried and fall through to text-only steer.
            if (sdkImages.length > 0) {
              io.to(room).emit("chat:error", {
                sessionId,
                error: "Image attachments are ignored when the agent is already streaming.",
              });
            }
            const mode: "steer" | "followUp" = behavior === "followUp" ? "followUp" : "steer";
            if (mode === "followUp") await session.followUp(message);
            else await session.steer(message);
            io.to(room).emit("chat:queued", { sessionId, behavior: mode });
            return;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await session.prompt(
            message,
            (sdkImages.length > 0 ? { images: sdkImages } : undefined) as any,
          );
          io.to(room).emit("chat:done", { sessionId });
          console.log(`[WS] chat:done sid=${sessionId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[WS] chat:send FAILED sid=${sessionId}:`, msg);
          io.to(room).emit("chat:error", { sessionId, error: msg });
          io.to(room).emit("chat:done", { sessionId });
        }
      },
    );

    socket.on("chat:abort", async (data: { sessionId: string }) => {
      console.log(`[WS] chat:abort sid=${data.sessionId} from=${socket.id}`);
      joinSession(socket, data.sessionId);
      const room = roomFor(data.sessionId);
      const session = piSessionManager.getSession(data.sessionId);
      if (session) {
        try {
          await session.abort();
          io.to(room).emit("chat:aborted", { sessionId: data.sessionId });
          io.to(room).emit("chat:done", { sessionId: data.sessionId });
        } catch (err) {
          io.to(room).emit("chat:error", { sessionId: data.sessionId, error: String(err) });
          io.to(room).emit("chat:done", { sessionId: data.sessionId });
        }
      } else {
        io.to(room).emit("chat:done", { sessionId: data.sessionId });
      }
    });

    socket.on("chat:new", async (data: { sessionId: string }) => {
      joinSession(socket, data.sessionId);
      const room = roomFor(data.sessionId);
      try {
        detachEventForwarder(data.sessionId);
        await piSessionManager.newSession(data.sessionId);
        attachEventForwarder(io, piSessionManager, data.sessionId);
        const session = piSessionManager.getSession(data.sessionId)!;
        io.to(room).emit("chat:new", {
          sessionId: data.sessionId,
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
          name: session.sessionName ?? null,
        });
      } catch (err) {
        io.to(room).emit("chat:error", { sessionId: data.sessionId, error: String(err) });
      }
    });

    socket.on("chat:resume", async (data: { sessionId: string; sessionFile: string }) => {
      joinSession(socket, data.sessionId);
      const room = roomFor(data.sessionId);
      try {
        detachEventForwarder(data.sessionId);
        await piSessionManager.resumeSession(data.sessionId, data.sessionFile);
        attachEventForwarder(io, piSessionManager, data.sessionId);
        const session = piSessionManager.getSession(data.sessionId)!;
        io.to(room).emit("chat:resumed", {
          sessionId: data.sessionId,
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
          name: session.sessionName ?? null,
          messages: session.messages,
        });
      } catch (err) {
        io.to(room).emit("chat:error", { sessionId: data.sessionId, error: String(err) });
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

    socket.on("chat:delete", async (data: { sessionFile: string }) => {
      const sessionFile = (data?.sessionFile ?? "").trim();
      if (!sessionFile) {
        socket.emit("chat:error", { sessionId: "", error: "sessionFile is required." });
        return;
      }
      try {
        await piSessionManager.deletePersistedSession(sessionFile);
        // Confirm to the requester, then broadcast the refreshed list so every
        // open Sessions view drops the deleted row.
        socket.emit("chat:deleted", { sessionFile });
        const sessions = await piSessionManager.listPersistedSessions();
        io.emit("chat:sessions", sessions);
        console.log(`[WS] Session deleted: ${sessionFile}`);
      } catch (err) {
        socket.emit("chat:error", { sessionId: "", error: String(err) });
      }
    });

    socket.on("chat:state", async (data: { sessionId: string; sessionFile?: string }) => {
      // Joining on chat:state covers the reload case: the browser asks for
      // current state on every (re)connect, which is also the right moment
      // to (re)subscribe to its session's events.
      joinSession(socket, data.sessionId);
      let session = piSessionManager.getSession(data.sessionId);

      // Auto-reconnect after a server restart. A fresh process has an empty
      // in-memory session map, so a reconnecting client would otherwise get an
      // empty chat even though the conversation is persisted on disk.
      if (!session) {
        try {
          if (data.sessionFile) {
            // Multi-session correct: restore THIS client's specific session by
            // file. With many concurrent sessions, "most recent" would hand
            // every client the same conversation — resuming the known file
            // keeps them isolated and accurate.
            await piSessionManager.getOrCreateSession(data.sessionId, {
              sessionFile: data.sessionFile,
            });
            session = piSessionManager.getSession(data.sessionId);
          } else {
            // No remembered file (e.g. first run): fall back to the most recent
            // persisted session for this cwd.
            const persisted = await piSessionManager.listPersistedSessions();
            if (persisted.length > 0) {
              await piSessionManager.getOrCreateSession(data.sessionId, { continueRecent: true });
              session = piSessionManager.getSession(data.sessionId);
            }
          }
          if (session) {
            attachEventForwarder(io, piSessionManager, data.sessionId);
            console.log(`[WS] restored session on reconnect sid=${data.sessionId}`);
          }
        } catch (err) {
          console.error(`[WS] chat:state restore failed sid=${data.sessionId}:`, err);
        }
      }

      if (!session) {
        socket.emit("chat:state:result", { sessionId: data.sessionId, state: null });
        return;
      }
      socket.emit("chat:state:result", {
        sessionId: data.sessionId,
        state: {
          sessionFile: session.sessionFile,
          piSessionId: session.sessionId,
          name: session.sessionName ?? null,
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
      "session:setModel",
      async (data: { sessionId: string; provider: string; modelId: string }) => {
        joinSession(socket, data.sessionId);
        const room = roomFor(data.sessionId);
        try {
          await piSessionManager.getOrCreateSession(data.sessionId);
          const model = await piSessionManager.setSessionModel(
            data.sessionId,
            data.provider,
            data.modelId,
          );
          io.to(room).emit("session:modelChanged", { sessionId: data.sessionId, model });
          console.log(`[WS] Model set: ${data.provider}/${data.modelId}`);
        } catch (err) {
          socket.emit("session:error", { error: String(err) });
        }
      },
    );

    socket.on("session:setName", async (data: { sessionId: string; name: string }) => {
      joinSession(socket, data.sessionId);
      const room = roomFor(data.sessionId);
      const name = (data.name ?? "").trim();
      if (!name) {
        socket.emit("session:error", { error: "Session name cannot be empty." });
        return;
      }
      try {
        await piSessionManager.getOrCreateSession(data.sessionId);
        const resolved = piSessionManager.setSessionName(data.sessionId, name);
        io.to(room).emit("session:nameChanged", { sessionId: data.sessionId, name: resolved });
        console.log(`[WS] Session named: ${data.sessionId} -> ${resolved}`);
      } catch (err) {
        socket.emit("session:error", { error: String(err) });
      }
    });

    socket.on(
      "session:setThinkingLevel",
      async (data: { sessionId: string; level: ThinkingLevel }) => {
        joinSession(socket, data.sessionId);
        const room = roomFor(data.sessionId);
        try {
          await piSessionManager.getOrCreateSession(data.sessionId);
          piSessionManager.setSessionThinkingLevel(data.sessionId, data.level);
          io.to(room).emit("session:thinkingLevelChanged", {
            sessionId: data.sessionId,
            level: data.level,
          });
        } catch (err) {
          socket.emit("session:error", { error: String(err) });
        }
      },
    );

    socket.on("disconnect", () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });
}
