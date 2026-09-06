import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native Node module; keep it out of the webpack bundle.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
