// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { safeNextPath } from "@/utils/safe-next";

/**
 * Where an OAuth, SSO or confirmed-signup sign-in lands. Pure; `auth-actions.ts`
 * sets the cookie before the provider redirect (or before sending the
 * confirmation email), and the auth callback and `/auth/confirm` consume it.
 *
 * A password sign-in returns to its `next` on the client, but a provider round trip
 * or an emailed link leaves the site, and the place to come back to must not ride
 * in the provider redirect URL: it would have to be allow-listed per value in
 * Supabase, and it is a parameter anyone can craft. So it travels in a short-lived
 * httpOnly cookie scoped to `/auth`, vetted by {@link safeNextPath} when it is set
 * AND again when it is read, and cleared as it is used.
 *
 * The cookie belongs to the browser that started: a confirmation link opened in
 * another browser lands on the default, and the invitee reopens their link.
 */

export const AUTH_NEXT_COOKIE = "tg_auth_next";

/** Where a sign-in lands with no (or no usable) `next`. */
export const DEFAULT_LANDING = "/workspace";

/** The only paths the cookie is sent to: `/auth/callback` and `/auth/confirm`. */
export const AUTH_NEXT_COOKIE_PATH = "/auth";

/** Long enough to sign in at the provider (an IdP may prompt for MFA) or to fetch
 *  a confirmation email, short enough that an abandoned attempt does not steer a
 *  much later sign-in. Every provider sign-in also replaces or clears it. */
const AUTH_NEXT_MAX_AGE_SECONDS = 30 * 60;

/**
 * The cookie to set before redirecting to the provider, or null when `next` is not
 * a path on this site — the caller then clears any cookie an earlier, abandoned
 * attempt left behind.
 */
export function authNextCookie(next: unknown, secure: boolean) {
  const path = typeof next === "string" ? safeNextPath(next) : null;
  if (!path) return null;
  return {
    name: AUTH_NEXT_COOKIE,
    value: path,
    options: {
      httpOnly: true,
      secure,
      sameSite: "lax" as const,
      path: AUTH_NEXT_COOKIE_PATH,
      maxAge: AUTH_NEXT_MAX_AGE_SECONDS,
    },
  };
}

/**
 * Where a completed sign-in lands: an explicit `next` on the link when it is a
 * same-site path, else the cookie's, else the workspace. Both are re-vetted, so a
 * cookie or a link written by hand cannot open-redirect.
 */
export function landingAfterSignIn(
  cookieValue: string | null | undefined,
  explicitNext?: string | null,
): string {
  return safeNextPath(explicitNext) ?? safeNextPath(cookieValue) ?? DEFAULT_LANDING;
}

/** A link to `path` (`/login`, `/signup`) that keeps a vetted `next`, so moving
 *  between sign-in and sign-up — or being sent back to sign in — keeps the place
 *  to return to. */
export function withNext(path: string, next: string | null | undefined): string {
  const vetted = safeNextPath(next);
  return vetted && vetted !== DEFAULT_LANDING ? `${path}?next=${encodeURIComponent(vetted)}` : path;
}
