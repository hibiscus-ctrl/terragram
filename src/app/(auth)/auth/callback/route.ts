// ref: https://github.com/vercel/next.js/blob/canary/examples/with-supabase/app/auth/callback/route.ts

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

async function handleGet(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  // Where an OAuth/SSO sign-in asked to return (set by the sign-in action, never
  // carried in the URL). Single-use: cleared on every way out of this handler.
  const jar = await cookies();
  const next = landingAfterSignIn(jar.get(AUTH_NEXT_COOKIE)?.value);
  jar.delete({ name: AUTH_NEXT_COOKIE, path: AUTH_NEXT_COOKIE_PATH });

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user?.id) {
      return NextResponse.redirect(`${SITE_URL}${withNext("/login", next)}`);
    }

    // Provisioning seam (route handler, not a render — the writes are safe here).
    await provisionSignedInUser(user);

    // Authenticated — land where the sign-in asked (re-vetted), else the workspace.
    return NextResponse.redirect(`${SITE_URL}${next}`);
  }

  return NextResponse.redirect(SITE_URL);
}

export const GET = withRedirectErrors(`${SITE_URL}/login`)(handleGet);
