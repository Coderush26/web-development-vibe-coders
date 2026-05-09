import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["172.16.21.8"],
  output: "standalone",
};

export default nextConfig;
