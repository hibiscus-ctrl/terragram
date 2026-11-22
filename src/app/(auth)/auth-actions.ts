"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  AUTH_NEXT_COOKIE,
  AUTH_NEXT_COOKIE_PATH,
  authNextCookie,
} from "@/features/account/controllers/auth-next-core";
import { provisionSignedInUser } from "@/features/account/controllers/provision-on-sign-in";
import { googleOauthEnabled } from "@/config/flags";
import { actionClientIp } from "@/features/api/rate-limit-route";
import { logger } from "@/libs/log";
import { rateLimit, retryAfterLabel } from "@/libs/rate-limit";
import { createSupabaseServerClient } from "@/libs/supabase/supabase-server-client";
import type { ActionResponse } from "@/types/action-response";
import { siteUrl } from "@/utils/site-url";

const log = logger("auth/actions");

/** Per-IP limiter for the PRE-AUTH actions. Every dashboard action throttles per
 *  user, but these run before any user exists — without an IP cap they are open to
 *  credential stuffing (login), account probing (signup) and SSO-domain
 *  enumeration. Supabase Auth throttles too; this is the app-side cap. */
async function authActionRateLimit(
  name: string,
  opts: { limit: number; windowMs: number },
): Promise<ActionResponse | null> {
  const limited = await rateLimit(`auth:${name}:${await actionClientIp()}`, opts);
  if (limited.ok) return null;
  return {
    ok: false,
    error: `Too many attempts. Try again in ${retryAfterLabel(limited.retryAfterMs)}.`,
  };
}

/**
 * Remember where a provider sign-in (or a sign-up confirmed by email) should land,
 * for the auth callback and `/auth/confirm`: a vetted same-site path in a
 * short-lived httpOnly cookie (`auth-next-core.ts`), never in the redirect URL. With no usable `next`, clear whatever an abandoned
 * earlier attempt left, so it cannot steer this sign-in.
 */
async function rememberNext(next: unknown): Promise<void> {
  const jar = await cookies();
  const cookie = authNextCookie(next, process.env.NODE_ENV === "production");
  if (cookie) jar.set(cookie.name, cookie.value, cookie.options);
  else jar.delete({ name: AUTH_NEXT_COOKIE, path: AUTH_NEXT_COOKIE_PATH });
}

/** Sign in with an email + password. Returns `{ ok: false, error }` for the client
 *  to surface; on success the session cookie is set and the client redirects. */
export async function signInWithPassword(email: string, password: string): Promise<ActionResponse> {
  const limited = await authActionRateLimit("login", { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Generic message (anti-enumeration); nudge toward the social buttons for
    // OAuth-only accounts — naming only the providers that are actually enabled.
    const social = googleOauthEnabled() ? "GitHub or Google" : "GitHub";
    return {
      ok: false,
      error: `Invalid email or password. If you signed up with ${social}, use that button instead.`,
    };
  }
  // Provision like the OAuth/confirmation callback does. A user who confirmed out of
  // band (or whose callback provisioning failed) would otherwise sign in org-less and
  // get trapped in the guard→/login→/billing redirect loop.
  if (data.user) await provisionSignedInUser(data.user);
  revalidatePath("/", "layout");
  return { ok: true, redirectTo: "/workspace" };
}

/** Create an email + password account. Detects an already-registered email (incl.
 *  GitHub-only accounts, which Supabase obfuscates as an identity-less user) and
 *  asks the user to sign in instead. `next` is where the confirmation link lands
 *  them (the client follows it itself when no confirmation is needed). */
export async function signUpWithPassword(
  email: string,
  password: string,
  next?: string,
): Promise<ActionResponse> {
  const limited = await authActionRateLimit("signup", { limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: siteUrl("/auth/callback") },
  });
  // Generic message (matches login's anti-enumeration stance) — the raw Supabase
  // error can leak signup-state detail. Weak-password feedback still gets through.
  if (error) {
    return {
      ok: false,
      error:
        error.code === "weak_password"
          ? "That password is too weak — use at least 8 characters."
          : "Could not create the account. Check the email address and try again.",
    };
  }

  // Supabase returns a user with an EMPTY identities array when the email is already
  // registered (anti-enumeration) — surface a friendly "sign in instead".
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return {
      ok: false,
      code: "already_exists",
      error: "An account with this email already exists. Please sign in instead.",
    };
  }

  // No session ⇒ email confirmation is required; a session ⇒ confirmation is off and we're in.
  if (!data.session) {
    await rememberNext(next);
    return { ok: true, needsConfirmation: true };
  }

  if (data.user) await provisionSignedInUser(data.user);
  revalidatePath("/", "layout");
  return { ok: true, redirectTo: "/workspace" };
}

/** Start a GitHub/Google sign-in. `next` (a same-site path, e.g. the invite link
 *  that sent the visitor here) is where the callback lands them. */
export async function signInWithOAuth(
  provider: "github" | "google",
  next?: string,
): Promise<ActionResponse> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: siteUrl("/auth/callback"),
    },
  });

  if (error) {
    // Log the provider detail server-side; return a generic message (matches the
    // anti-enumeration stance of the password actions above).
    log.error("signInWithOAuth failed", { provider, err: error });
    return { ok: false, error: "Could not start sign-in. Please try again." };
  }

  await rememberNext(next);
  return redirect(data.url);
}

/** Start a SAML SSO sign-in from a work email — Supabase routes the email's domain
 *  to the org's registered IdP and returns a redirect URL. Redirects on success;
 *  returns `{ ok: false, error }` (no IdP for that domain / bad email) for the client.
 *  Like OAuth, it returns through the auth callback, which lands it on `next`. */
export async function signInWithSso(email: string, next?: string): Promise<ActionResponse> {
  const limited = await authActionRateLimit("sso", { limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return { ok: false, error: "Enter your work email to use SSO." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithSSO({
    domain,
    options: { redirectTo: siteUrl("/auth/callback") },
  });
  if (error || !data?.url) {
    return { ok: false, error: "No single sign-on is set up for that email domain." };
  }
  await rememberNext(next);
  return redirect(data.url);
}

export async function signOut(): Promise<ActionResponse> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    log.error("signOut failed", { err: error });
    return { ok: false, error: "Could not sign out. Please try again." };
  }

  return { ok: true };
}
