/** @type {import('next').NextConfig} */

// Baseline security headers for the authenticated workspace + account surfaces.
// HSTS is effective because Railway terminates TLS in front of the app.
//
// Content-Security-Policy ships the directives that are safe to enforce app-wide
// with no per-route tuning: they close classic injection vectors (base-tag
// hijacking, <object>/<embed> plugins, clickjacking) without constraining where
// scripts/styles/connections may load from. The `script-src`/`style-src`/
// `connect-src` directives are deliberately still open — locking those down needs
// a per-request nonce (Next's inline runtime + GA) plus an allowlist for the
// Supabase browser client and analytics, verified against every interactive flow
// before enforcement. That remains the tracked follow-up.
const contentSecurityPolicy = ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"].join(
  "; ",
);

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Severs `window.opener` across origins, so a page this app links to (or one
  // that opens it) cannot navigate or probe the workspace's window. Nothing here
  // relies on a cross-origin popup: OAuth and Stripe are full-page redirects.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the Docker runtime
  // image ships only the files it needs — smaller, faster cold starts on Railway.
  output: "standalone",
  // Drop the `X-Powered-By: Next.js` banner — it discloses the framework to no
  // benefit and is a routine hardening checklist item.
  poweredByHeader: false,
  // Version-skew protection across deploys. Every build mints new Server Action
  // ids and chunk names, so a tab still running the previous deploy's JS would
  // otherwise POST action ids the new server cannot find. With an id set, a
  // mismatch on the next navigation turns into a full reload instead. The commit
  // SHA reaches the Docker build as an ARG (see Dockerfile); unset locally.
  deploymentId: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
