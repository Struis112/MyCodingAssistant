import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
};

export default nextConfig;
