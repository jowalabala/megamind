import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Next.js inlines its bootstrap scripts, so scripts can't be locked down without nonces yet;
  // this still blocks framing, plugins, base-tag tricks and loading from other origins.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Development hot reload evaluates code; production never does.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const config: NextConfig = {
  output: "standalone",
  // Monorepo root, so the standalone build includes workspace packages.
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@mm/db", "@mm/audit"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // CSV outcome uploads are up to 2 MB.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default config;
