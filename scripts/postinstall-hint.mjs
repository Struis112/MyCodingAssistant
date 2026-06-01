#!/usr/bin/env node
//
// Post-install hint. Prints a one-time pointer to `npm run setup` if the
// setup wizard has not been run yet, then exits silently.
//
// Intentionally non-interactive — runs during every `npm install` and we
// don't want to block CI / Docker builds.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = join(ROOT, ".mca-setup-done");

// Suppress in CI to keep logs clean.
if (process.env.CI === "true" || process.env.CI === "1") process.exit(0);
// Suppress on nested installs (workspaces re-running postinstall during
// `npm install`). The root postinstall runs from the repo root; child
// workspaces have a different INIT_CWD.
const initCwd = process.env.INIT_CWD;
if (initCwd && initCwd !== ROOT) process.exit(0);

if (existsSync(MARKER)) process.exit(0);

const c = (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const b = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

console.log("");
console.log(b("✓ MyCodingAssistant dependencies installed."));
console.log("");
console.log("First time on this machine? Run:");
console.log("  " + c("npm run setup"));
console.log("");
console.log("It's a short interactive wizard. On Windows it offers to install MCA");
console.log("as a service so the web + server auto-start on boot.");
console.log("");
console.log("To skip and just run in dev mode now:");
console.log("  " + c("npm run dev") + "    then open " + c("http://localhost:7642/"));
console.log("");
