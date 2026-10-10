import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The API routes read these at runtime via fs, which file tracing cannot see.
  outputFileTracingIncludes: {
    "/api/*": ["./data/snapshots/**/*", "./data/sample/**/*", "./data/classifications/**/*"],
  },
  // Cache Components stays off: the route handlers use `dynamic = "force-dynamic"`.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
