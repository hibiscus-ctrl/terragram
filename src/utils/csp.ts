/**
 * Content-Security-Policy for the Terragram app.
 *
 * WHY THIS EXISTS. `next.config.js` enforces the directives that are safe to apply
 * app-wide with no per-request state (`object-src`, `base-uri`, `frame-ancestors`).
 * The ones that actually contain an XSS — `script-src` and `connect-src` — need a
 * per-request nonce, so they are built here and attached by `src/proxy.ts`.
 *
 * ROLLOUT: this policy ships as `Content-Security-Policy-Report-Only`. It cannot
 * break a page; it only reports. Promote it to the enforcing header once a soak
 * across every interactive flow (sign-in, the workspace, checkout redirect, the
 * Git-host OAuth round trip, GA consent) comes back clean. `buildCspHeaderName()`
 * is the single switch — flip `CSP_ENFORCED` and the same policy starts enforcing.
 *
 * The nonce reaches Next by way of the *request* `Content-Security-Policy` header
 * (see proxy.ts): Next extracts it from there and stamps it onto its own framework
 * and bundle scripts. Without that, the report-only policy would report Next's own
 * bootstrap on every page load and the soak would be pure noise.
 */

/** Origins the browser genuinely talks to:
 *  - Supabase — the `@supabase/ssr` browser client (auth token refresh). Realtime
 *    (`wss:`) is deliberately absent: nothing in `src/` opens a channel, so the
 *    soak will say so rather than us pre-authorising it.
 *  - Google Analytics — loaded via `next/script` behind cookie consent.
 *  Stripe is NOT here on purpose: this app has no `@stripe/stripe-js`, and Checkout
 *  is a server-issued top-level redirect, which CSP fetch directives do not govern.
 *  The managed-model gateway is NOT here either: the browser never calls it — it
 *  posts to this app's own `/api/workspace/*` routes, which call the proxy. */
const GA_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
  "https://*.googletagmanager.com",
] as const;

/** Where violation reports are posted. Same-origin; see `app/api/csp-report`. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** The Reporting API endpoint GROUP name, shared by `report-to` and the header. */
export const CSP_REPORT_ENDPOINT = "csp";

/**
 * The `Reporting-Endpoints` response header value. `src/proxy.ts` sets this
 * alongside the policy; without it Chromium parses `report-to csp`, finds no group
 * of that name, and silently drops the report — a soak that reports nothing and a
 * clean soak look identical, which is the failure mode worth designing out.
 */
export function buildReportingEndpointsHeader(): string {
  return `${CSP_REPORT_ENDPOINT}="${CSP_REPORT_PATH}"`;
}

function supabaseOrigin(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Build the policy for one request. `nonce` must be fresh per request — a reused
 * nonce is equivalent to `'unsafe-inline'`.
 */
export function buildCspPolicy(
  nonce: string,
  isDev = process.env.NODE_ENV !== "production",
): string {
  const connect = ["'self'", supabaseOrigin(), ...GA_ORIGINS].filter(Boolean) as string[];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // `strict-dynamic` is what makes this robust: browsers that support it ignore
    // the host allowlist entirely and trust only the nonced script plus whatever
    // that script loads. `https:` is the fallback for browsers without it.
    // `unsafe-eval` is dev-only — the Next dev overlay/HMR needs it.
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "https:",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    // DELIBERATELY `unsafe-inline`, NOT a nonce. React writes inline `style={{…}}`
    // attributes (React Flow positions every node that way), and style ATTRIBUTES
    // cannot carry a nonce. Adding a nonce here would also silently disable this
    // allowance, since a nonce makes the browser ignore `unsafe-inline`.
    "style-src": ["'self'", "'unsafe-inline'"],
    // `blob:` — the canvas exports the diagram as an SVG blob the page then reads.
    "img-src": ["'self'", "blob:", "data:", ...GA_ORIGINS],
    "font-src": ["'self'", "data:"],
    "connect-src": connect,
    "frame-src": ["'none'"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    // Mirrors the enforced set in next.config.js so the report-only policy is a
    // superset — promoting it later needs no second edit there.
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    // BOTH reporting directives, because the browsers split and neither is
    // sufficient alone: Firefox and Safari implement only the deprecated
    // `report-uri`, Chromium only honours `report-to` (paired with the
    // `Reporting-Endpoints` response header from proxy.ts).
    "report-uri": [CSP_REPORT_PATH],
    "report-to": [CSP_REPORT_ENDPOINT],
  };

  const serialized = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

  // Only meaningful over TLS; Railway terminates TLS in front of the app.
  return isDev ? serialized : `${serialized}; upgrade-insecure-requests`;
}

/**
 * The response header to emit. Report-Only today — see the rollout note above.
 * Flipping this constant is the whole promotion step.
 */
const CSP_ENFORCED = false;

export function buildCspHeaderName():
  | "Content-Security-Policy"
  | "Content-Security-Policy-Report-Only" {
  return CSP_ENFORCED ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

/** Fresh 128-bit nonce, base64. `crypto` is available in the edge runtime. */
export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
