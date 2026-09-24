import type { NextConfig } from "next";

const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

// NOTE: the App Router embeds RSC flight data in inline <script> tags that
// Next cannot stamp with nonces, so script-src must allow 'unsafe-inline'
// for the app to hydrate at all. The policy still blocks remote script and
// eval injection, plugins/objects, framing, and base-tag hijacking. If you
// move flight data out of inline scripts (nonces/custom rendering), tighten
// script-src accordingly.
const cspHeader = {
  key: "Content-Security-Policy",
  value: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native Node module; keep it out of the webpack bundle.
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    // The CSP is enforced in production only: the dev toolchain (React dev
    // runtime) performs eval(), which the strict policy blocks and would
    // break local development and the e2e suite (which runs `next dev`).
    const headers =
      process.env.NODE_ENV === "production" ? [...baseHeaders, cspHeader] : baseHeaders;
    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
