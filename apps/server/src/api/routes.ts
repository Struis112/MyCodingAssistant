// REST API Routes — chat sessions and model list only.

import type { Express } from "express";
import type { PiSessionManager } from "../services/pi-session.js";

export function registerApiRoutes(app: Express, piSessionManager: PiSessionManager): void {
  // ----- Sessions -----

  app.get("/api/sessions/active", (_req, res) => {
    res.json(piSessionManager.listActiveSessions());
  });

  app.get("/api/sessions", async (_req, res) => {
    try {
      const sessions = await piSessionManager.listPersistedSessions();
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/sessions", async (req, res) => {
    try {
      const { sessionId } = req.body ?? {};
      const id = sessionId || crypto.randomUUID();
      await piSessionManager.newSession(id);
      res.json({ success: true, sessionId: id });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.delete("/api/sessions/:id", (req, res) => {
    piSessionManager.disposeSession(req.params.id);
    res.json({ success: true });
  });

  // ----- Models -----

  app.get("/api/models", async (_req, res) => {
    try {
      const models = await piSessionManager.getAvailableModels();
      res.json(models);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
