// REST API Routes — chat sessions, model list, and file-edit revert.

import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Express } from "express";
import type { ConnectorManager } from "../connectors/types.js";
import { parseUnifiedPatch, resolveWithinRoot, reverseApply } from "../services/revert.js";

export function registerApiRoutes(
  app: Express,
  piSessionManager: ConnectorManager,
  options: { cwd?: string } = {},
): void {
  // Project root used to validate file paths and resolve revert targets. Matches
  // the agent's working directory (PiSessionManager defaults to process.cwd()).
  const cwd = options.cwd ?? process.cwd();
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

  // ----- Files -----

  // Revert a single `edit` change by reverse-applying its unified patch
  // (`details.patch`). Safe: it only writes when the current file still
  // contains the edited block verbatim, and refuses paths outside the project.
  app.post("/api/files/revert", async (req, res) => {
    const { path: filePath, patch } = req.body ?? {};
    if (typeof filePath !== "string" || typeof patch !== "string") {
      res.status(400).json({ success: false, error: "`path` and `patch` are required strings." });
      return;
    }

    const abs = resolveWithinRoot(cwd, filePath);
    if (!abs) {
      res.status(403).json({ success: false, error: "Path is outside the project directory." });
      return;
    }

    const hunks = parseUnifiedPatch(patch);
    if (hunks.length === 0) {
      res.status(400).json({ success: false, error: "Patch contained no hunks." });
      return;
    }

    try {
      const current = await readFile(abs, "utf-8");
      const result = reverseApply(current, hunks);
      if (!result.ok) {
        res.status(409).json({ success: false, error: result.reason });
        return;
      }
      await writeFile(abs, result.text);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Open a file in the OS default application (browser for .html, editor for
  // source, etc.). Local-only convenience: the server runs on the same machine
  // as the user, so it can hand the path to the platform opener. Refuses any
  // path outside the project root and anything that isn't a regular file.
  app.post("/api/files/open", async (req, res) => {
    const { path: filePath } = req.body ?? {};
    if (typeof filePath !== "string" || !filePath) {
      res.status(400).json({ success: false, error: "`path` is required." });
      return;
    }

    const abs = resolveWithinRoot(cwd, filePath);
    if (!abs) {
      res.status(403).json({ success: false, error: "Path is outside the project directory." });
      return;
    }

    try {
      const info = await stat(abs);
      if (!info.isFile()) {
        res.status(404).json({ success: false, error: "Not a regular file." });
        return;
      }
    } catch {
      res.status(404).json({ success: false, error: "File not found." });
      return;
    }

    try {
      openInOs(abs);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ----- File browser / editor (local, project-confined) -----
  //
  // These power the in-screen file explorer (left drawer) and editor (right
  // drawer). Every path is confined to the project root via resolveWithinRoot
  // — the same guard the revert/open routes use — so a client can never read
  // or write outside the working directory. Note: the server has no auth, so
  // keep MCA bound to localhost (see security guidance).
  const IGNORED_DIRS = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "coverage",
    ".turbo",
    ".cache",
  ]);
  const MAX_EDIT_BYTES = 2 * 1024 * 1024; // 2 MB — refuse to open larger files in-browser

  const toPosix = (p: string) => p.split(path.sep).join("/");

  // List the immediate children of a directory (lazy tree — the explorer
  // fetches children on expand). `dir` is a project-relative path; empty
  // means the project root.
  app.get("/api/files/list", async (req, res) => {
    const rel = (typeof req.query.dir === "string" ? req.query.dir : "").replace(/\\/g, "/");
    // resolveWithinRoot rejects the root itself (it's meant for files), so
    // handle the root listing explicitly while still confining subdirs.
    const abs = rel === "" || rel === "." || rel === "/" ? cwd : resolveWithinRoot(cwd, rel);
    if (!abs) {
      res.status(403).json({ error: "Path is outside the project directory." });
      return;
    }
    try {
      const dirents = await readdir(abs, { withFileTypes: true });
      const entries = dirents
        .filter((d) => !(d.isDirectory() && IGNORED_DIRS.has(d.name)))
        .map((d) => ({
          name: d.name,
          path: toPosix(path.relative(cwd, path.join(abs, d.name))),
          type: d.isDirectory() ? ("dir" as const) : ("file" as const),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ dir: toPosix(path.relative(cwd, abs)), entries });
    } catch (err) {
      res.status(404).json({ error: `Cannot list directory: ${String(err)}` });
    }
  });

  // Read a file's UTF-8 contents for editing.
  app.get("/api/files/read", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!rel) {
      res.status(400).json({ error: "`path` query param is required." });
      return;
    }
    const abs = resolveWithinRoot(cwd, rel);
    if (!abs) {
      res.status(403).json({ error: "Path is outside the project directory." });
      return;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile()) {
        res.status(404).json({ error: "Not a regular file." });
        return;
      }
      if (info.size > MAX_EDIT_BYTES) {
        res.status(413).json({ error: "File is too large to edit in the browser (>2 MB)." });
        return;
      }
      const content = await readFile(abs, "utf-8");
      res.json({ path: toPosix(path.relative(cwd, abs)), content, size: info.size });
    } catch {
      res.status(404).json({ error: "File not found." });
    }
  });

  // Overwrite a file's contents. Only writes within the project root; the file
  // must already exist (we refuse to create new paths from the editor for now).
  app.post("/api/files/save", async (req, res) => {
    const { path: filePath, content } = req.body ?? {};
    if (typeof filePath !== "string" || typeof content !== "string") {
      res.status(400).json({ success: false, error: "`path` and `content` are required strings." });
      return;
    }
    const abs = resolveWithinRoot(cwd, filePath);
    if (!abs) {
      res.status(403).json({ success: false, error: "Path is outside the project directory." });
      return;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile()) {
        res.status(404).json({ success: false, error: "Not a regular file." });
        return;
      }
    } catch {
      res.status(404).json({ success: false, error: "File not found." });
      return;
    }
    try {
      await writeFile(abs, content);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
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

// Hand an absolute path to the platform's default "open" mechanism. Spawned
// detached + unref'd so a slow GUI launch never blocks the request, and with
// args passed as an array (no shell string interpolation) to avoid injection.
function openInOs(absPath: string): void {
  if (process.platform === "win32") {
    // `start` is a cmd builtin; the empty "" is the window title so a quoted
    // path isn't mistaken for one.
    spawn("cmd", ["/c", "start", "", absPath], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [absPath], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [absPath], { detached: true, stdio: "ignore" }).unref();
  }
}
