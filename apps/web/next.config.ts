import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const config: NextConfig = {
  output: "standalone",
  // Monorepo root, so the standalone build includes workspace packages.
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@mm/db", "@mm/audit"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default config;
