// Dev-supervised entrypoint. Like start-prod.ts, but picks the web *dev*
// profile: the supervisor runs `next dev` (instant fast-refresh + browser
// auto-refresh) instead of `next start` against a production build.
//
// Use this when you want a single supervised process that also serves a live
// dev UI — edits to apps/web/src show up immediately, no rebuild loop, and the
// crash-restart / self-repair behaviour still applies.
//
// Run via `npm run dev:supervised` at the repo root. Don't also run
// `npm run dev:web` — the supervisor already owns the web dev server on the
// same port.
process.env.MCA_SUPERVISE_WEB = "1";
process.env.MCA_WEB_DEV = "1";
process.env.NODE_ENV = "development";
await import("./index.js");

// Mark this file as a module so top-level `await` is permitted under
// TypeScript's --isolatedModules / --module nodenext settings.
export {};
