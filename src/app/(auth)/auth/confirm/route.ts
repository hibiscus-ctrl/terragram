// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { EmailOtpType } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  AUTH_NEXT_COOKIE,
  AUTH_NEXT_COOKIE_PATH,
  landingAfterSignIn,
  withNext,
} from "@/features/account/controllers/auth-next-core";
import { provisionSignedInUser } from "@/features/account/controllers/provision-on-sign-in";
import { withRedirectErrors } from "@/features/api/route-errors";
import { createSupabaseServerClient } from "@/libs/supabase/supabase-server-client";
import { SITE_URL } from "@/utils/site-url";

/**
 * GET /auth/confirm — server-side email verification for the signup confirmation,
 * magic-link, recovery and email-change links. This is the token-hash flow, NOT the
 * `/auth/callback` PKCE `?code` flow: an emailed link can't carry a PKCE
 * `code_verifier` (the browser that clicks it may not be the one that began the
 * flow), so for these links GoTrue falls back to an implicit hash-fragment token that
 * the server callback can never read. `verifyOtp` exchanges the `token_hash`
 * server-side, sets the session cookie, and — like the OAuth callback — provisions
 * the org before landing the user in the app. The auth email templates point here.
 */

async function handleGet(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // The link's own `next`, else the one sign-up remembered in this browser (a
  // cookie, cleared here on every way out). Only a path on this site is honoured,
  // so a crafted link or cookie can't open-redirect after auth.
  const jar = await cookies();
  const next = landingAfterSignIn(jar.get(AUTH_NEXT_COOKIE)?.value, searchParams.get("next"));
  jar.delete({ name: AUTH_NEXT_COOKIE, path: AUTH_NEXT_COOKIE_PATH });

  if (tokenHash && type) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error && data.user) {
      // Provisioning seam (route handler, not a render — the writes are safe here).
      await provisionSignedInUser(data.user);
      return NextResponse.redirect(`${SITE_URL}${next}`);
    }
  }

  // A spent or bogus link: sign in instead, keeping the place to return to.
  return NextResponse.redirect(`${SITE_URL}${withNext("/login", next)}`);
}

export const GET = withRedirectErrors(`${SITE_URL}/login`)(handleGet);
