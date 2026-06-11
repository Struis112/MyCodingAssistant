import type { NextConfig } from "next";
import path from "node:path";

// Pin the workspace root to this repo. Without this, Next.js walks up the
// directory tree looking for the nearest package-lock.json and — if an
// unrelated lockfile exists anywhere above us (e.g. a stray
// C:\Users\<you>\package-lock.json) — it picks that directory as the root.
// The Watchpack file-watcher then scans the entire user home tree, throws
// EINVAL on system files like C:\DumpStack.log.tmp and C:\pagefile.sys,
// scrambles the dev React Client Manifest, and the page renders as 500.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Build-output isolation: `next dev` (hybrid mode) serves live from .next,
  // and a concurrent `next build` into the SAME dir corrupts it (the
  // 2026-06-10 "routes-manifest missing / every page 500s" incident). Any
  // production build must therefore set NEXT_DIST_DIR (e.g. .next-prod) so
  // the two can never collide.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  // apps/web -> repo root is two levels up.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // Linting is owned by oxlint at the repo root (see .oxlintrc.json with the
  // `nextjs` + `jsx-a11y` plugins). Next 16 dropped its built-in ESLint pass,
  // so no opt-out is needed anymore.
};

export default nextConfig;
