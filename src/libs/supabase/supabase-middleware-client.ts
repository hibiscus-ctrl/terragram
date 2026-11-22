// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// Ref: https://supabase.com/docs/guides/auth/server-side/nextjs

import { type NextRequest, NextResponse } from "next/server";

import { getEnvVar } from "@/utils/get-env-var";
import { createServerClient } from "@supabase/ssr";

/** Path prefixes that require an authenticated session. Every org-scoped
 *  dashboard page now lives under `/o/{slug}/...`, one prefix covers all of it. */
const PROTECTED_PREFIXES = [
  "/workspace", // the diagram workspace (personal, account-scoped)
  "/billing", // personal billing dashboard
  "/settings", // personal account settings
  "/members", // org members and invites
  "/account",
  "/manage-subscription",
];

/** Matches the org slug out of a `/o/{slug}/...` request path. */
const ORG_SLUG_RE = /^\/o\/([^/]+)/;
/** Header the proxy stamps so `get-or-create-org.ts` can resolve "the current
 *  org" ambiently — read by every `getCurrentOrg`/`getCurrentMembership()` call,
 *  including ones with no route params in scope (server actions, `reads/*`). */
const ACTIVE_ORG_HEADER = "x-active-org";
/** Convenience-only cookie remembering the last org visited, so a fresh
 *  sign-in or a bare `/login` redirect can land back where the user was.
 *  Never trusted as authorization — re-verified by `resolveDefaultOrgSlug()`. */
const LAST_ORG_COOKIE = "last_org";

export async function updateSession(request: NextRequest) {
  // The active-org header must ONLY ever come from this trusted path parse —
  // strip any client-supplied value first so a request can't spoof it on a
  // route that doesn't carry an `/o/{slug}` segment (membership is still
  // re-verified downstream; this is defense-in-depth against header injection).
  request.headers.delete(ACTIVE_ORG_HEADER);
  const orgSlug = ORG_SLUG_RE.exec(request.nextUrl.pathname)?.[1];
  if (orgSlug) request.headers.set(ACTIVE_ORG_HEADER, orgSlug);

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    getEnvVar(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    getEnvVar(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          supabaseResponse = NextResponse.next({
            request,
          });

          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Do not run code between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  // IMPORTANT: DO NOT REMOVE auth.getUser() — calling it refreshes the auth cookies.

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Route guard: the dashboard + account areas require a signed-in user. Marketing,
  // the auth pages, and the Action-facing /api/* routes (which authenticate with org
  // tokens, not a session) stay public. Redirect signed-out visitors to /login.
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirectResponse = NextResponse.redirect(url);
    // Carry over any auth cookies refreshed above so the session stays consistent.
    for (const cookie of supabaseResponse.cookies.getAll()) {
      redirectResponse.cookies.set(cookie);
    }
    return redirectResponse;
  }

  // Remember the org last visited — a convenience for `resolveDefaultOrgSlug()`,
  // never trusted as authorization (re-verified there against real membership).
  if (orgSlug) {
    supabaseResponse.cookies.set(LAST_ORG_COOKIE, orgSlug, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is.
  // If you're creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely!

  return supabaseResponse;
}
