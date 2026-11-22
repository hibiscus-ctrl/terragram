// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserMetadata } from "@supabase/supabase-js";
import { cache } from "react";

import { logger } from "@/libs/log";
import { createSupabaseServerClient } from "@/libs/supabase/supabase-server-client";

const log = logger("account/auth");

/**
 * The verified identity the RENDER path needs. Deliberately narrower than
 * Supabase's `User`: these fields are everything the pages, server actions and
 * routes use, and they are the ones carried in the access token itself.
 *
 * Anything richer — `email_confirmed_at`, `identities`, `app_metadata` — is NOT a
 * JWT claim we rely on and cannot be served from a locally verified token. Those
 * live on the sign-in provisioning path, which still fetches the full user from
 * the Auth server (`provision-on-sign-in.ts`).
 */
export type AuthenticatedUser = {
  id: string;
  email: string | undefined;
  user_metadata: UserMetadata;
};

/**
 * The authenticated user for this request, verified — never merely decoded.
 *
 * `getClaims()` rather than `getUser()`: the project signs its JWTs with an
 * asymmetric key, so the token is verified LOCALLY against the cached JWKS with no
 * call to the Auth server. The proxy already makes one `getUser()` round trip per
 * request to refresh the session cookies; the render path no longer pays for a
 * second one. This is still a real signature check, not `getSession()`: a forged
 * or tampered token fails verification, and on a symmetric-secret project
 * `getClaims()` falls back to asking the Auth server.
 *
 * Wrapped in React `cache()` so the layout, `getCurrentOrg`, and the page that all
 * need the user within one request share a single verification.
 */
export const getAuthenticatedUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.getClaims();

  if (error) {
    // `AuthSessionMissingError` is the expected result for a signed-out visitor — don't treat it as an error.
    if (error.name !== "AuthSessionMissingError") log.error("getClaims failed", { err: error });
    return null;
  }

  // `{ data: null, error: null }` is the other signed-out shape (no token at all).
  if (!data) return null;

  const { claims } = data;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    user_metadata: claims.user_metadata ?? {},
  };
});
