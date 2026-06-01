# MyCodingAssistant — security rules

Project-specific rules for the security-guidance plugin's LLM diff review.
These are things the model can't infer from generic web-vuln knowledge; the
built-in rules already cover injection/XSS/SSRF/secrets/etc. Treat the items
below as MUST unless a line carries an inline justification.

## Threat model (read first)

- The server (`apps/server`) binds `0.0.0.0` by default and has **no
  authentication or authorization** on any REST route or WebSocket event. It
  is meant to run locally, same machine as the user.
- Because there is no auth, every endpoint must assume its input is the only
  trust boundary. Do **not** add features that rely on "the caller is
  authenticated/trusted." If a change opens a new way to read/write files or
  spawn processes, it must carry its own guards (below).
- Never widen the network exposure implicitly. Binding to `0.0.0.0` plus a new
  unguarded filesystem/exec endpoint = remote code execution on the LAN. Flag
  any such combination.

## Filesystem access — path confinement is mandatory

- Any filesystem path that originates from an HTTP request body, query, or a
  WebSocket payload MUST be resolved through `resolveWithinRoot(cwd, path)`
  (`apps/server/src/services/revert.ts`) and the request rejected (403) when it
  returns null. See `/api/files/revert` and `/api/files/open` for the pattern.
- Never call `fs`/`fs/promises` functions (`readFile`, `writeFile`, `stat`,
  `rm`, `open`, …) directly on a client-supplied path without that
  confinement check first.
- `sessionFile` in the `chat:resume` WebSocket handler is client-supplied and
  flows into the Pi SDK. Validate it stays within the sessions directory before
  resuming — do not trust it as a free-form path.
- Do not use a client-supplied `sessionId` to build a filesystem path without
  confinement; it is fine as a room name / map key only.

## Spawning processes — no shells, args as arrays

- Use `child_process.spawn` with the arguments passed as an **array**. Never
  pass `shell: true`, never build a single command string, never use
  `exec`/`execSync`/`spawnSync` with interpolated user input. The `openInOs`
  helper in `apps/server/src/api/routes.ts` is the reference implementation.
- The web supervisor (`web-supervisor.ts`) spawns `next` via `process.execPath`
  with an explicit args array — keep that shape; do not switch to a shell.
- Never let request/WS input become an argv element that could be interpreted
  as a flag or a path outside the project without confinement.

## CORS / origins

- Express CORS and the socket.io server are locked to `WEB_ORIGIN`
  (`MCA_WEB_ORIGIN`, default `http://localhost:3000`). Do not set `origin: "*"`,
  do not reflect/echo the request `Origin`, and do not add `credentials: true`
  with a wildcard origin.

## Secrets

- Provider API keys and credentials come from environment / Pi SDK config.
  Never log them, never include them in errors forwarded to the client, never
  write them into session files, and never put secrets in this file (its
  contents are sent to the review model on every turn).
- `String(err)` is forwarded to the browser in several handlers. That is
  acceptable for this local tool, but do not start interpolating secrets,
  tokens, or absolute paths outside the project into error messages.

## SQL (better-sqlite3)

- If any raw SQL is added, use parameterized statements
  (`db.prepare(...).run(?, ?)`). Never string-concatenate session ids or any
  user input into a SQL string.
