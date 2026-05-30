// REST API Routes

import type { Express } from 'express';
import type { PiSessionManager } from '../services/pi-session.js';
import type { ServiceManager } from '../services/service-manager.js';

export function registerApiRoutes(
  app: Express,
  piSessionManager: PiSessionManager,
  serviceManager: ServiceManager
): void {
  // --- Sessions ---
  app.get('/api/sessions', (_req, res) => {
    res.json(piSessionManager.listSessions());
  });

  app.post('/api/sessions', async (req, res) => {
    try {
      const { sessionId, cwd } = req.body;
      const id = sessionId || crypto.randomUUID();
      await piSessionManager.createSession(id, cwd);
      res.json({ success: true, sessionId: id });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  app.delete('/api/sessions/:id', (req, res) => {
    piSessionManager.disposeSession(req.params.id);
    res.json({ success: true });
  });

  // --- Models ---
  app.get('/api/models', async (_req, res) => {
    try {
      const models = await piSessionManager.getAvailableModels();
      res.json(models);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // --- Services ---
  app.get('/api/services', (_req, res) => {
    res.json(serviceManager.getStatus());
  });

  app.post('/api/services/:name/start', async (req, res) => {
    try {
      await serviceManager.startService(req.params.name);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  app.post('/api/services/:name/stop', async (req, res) => {
    try {
      await serviceManager.stopService(req.params.name);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  app.post('/api/services/:name/restart', async (req, res) => {
    try {
      await serviceManager.restartService(req.params.name);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });
}
