import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pins the workspace root explicitly. Without this, Turbopack scans upward for the nearest
  // lockfile and can pick up an unrelated one outside this repo, which is exactly what happened
  // in dev (a stray package-lock.json in the host user's home directory).
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
