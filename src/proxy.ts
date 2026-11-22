// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { NextRequest } from "next/server";

import { updateSession } from "@/libs/supabase/supabase-middleware-client";
import {
  buildCspHeaderName,
  buildCspPolicy,
  buildReportingEndpointsHeader,
  generateNonce,
} from "@/utils/csp";

// Next.js 16 renamed the `middleware` convention to `proxy`.

/**
 * Stamp a per-request CSP nonce onto the REQUEST headers.
 *
 * Two headers, two different jobs:
 *  - `x-nonce` is for our own code — a server component rendering a bespoke inline
 *    script reads it via `headers()`.
 *  - `Content-Security-Policy` on the *request* is how Next itself learns the
 *    nonce: it extracts it from here and applies it to the framework runtime, the
 *    page bundles and its own inline scripts. Without this the report-only policy
 *    below would report Next's own bootstrap on every page load.
 *
 * Mutating `request.headers` propagates because `updateSession` forwards the
 * request into `NextResponse.next({ request })`.
 */
function applyCspToRequest(request: NextRequest): string {
  const nonce = generateNonce();
  const policy = buildCspPolicy(nonce);
  request.headers.set("x-nonce", nonce);
  request.headers.set("Content-Security-Policy", policy);
  return policy;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // `/api/*` is machine-to-machine (session cookies / HMAC), never a browser
  // document, so a CSP there is pointless overhead. Everything that can render
  // HTML gets one.
  const wantsCsp = !pathname.startsWith("/api");
  const policy = wantsCsp ? applyCspToRequest(request) : null;

  const response = await updateSession(request);

  // Report-Only for now (see src/utils/csp.ts) — this cannot break a page, it only
  // reports. Set on the response last so it survives the redirect branches inside
  // `updateSession`. `Reporting-Endpoints` goes on the SAME responses as the
  // policy: a group declared without a policy is inert, and a policy naming a
  // group the response never declared is worse, because it looks instrumented.
  if (policy) {
    response.headers.set(buildCspHeaderName(), policy);
    response.headers.set("Reporting-Endpoints", buildReportingEndpointsHeader());
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
