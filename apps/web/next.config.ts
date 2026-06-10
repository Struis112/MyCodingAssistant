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
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  // apps/web -> repo root is two levels up.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // Linting is owned by oxlint at the repo root (see .oxlintrc.json with the
  // `nextjs` + `jsx-a11y` plugins). Skip Next's built-in ESLint pass during
  // `next build` so we don't depend on eslint-config-next anymore.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
