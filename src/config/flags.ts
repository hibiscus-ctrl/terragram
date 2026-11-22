// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deployment feature flags — every non-secret env toggle is read here, so a
 * grep for a flag finds one file. Secrets stay behind `getEnvVar`/lazy clients.
 */

/** Stripe Tax (UK/EU VAT) — must be ACTIVATED in the Stripe dashboard per mode
 *  before it can be requested on a session; flip on once Tax is live (GO-LIVE.md §2). */
export function stripeTaxEnabled(): boolean {
  return process.env.STRIPE_TAX_ENABLED === "true";
}

/** Show "Continue with Google" only once the Supabase Google provider is configured. */
export function googleOauthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true";
}

/** Show "Continue with GitHub" only once the Supabase GitHub provider is configured.
 *  Same rule as Google: a sign-in button for a provider that does not exist sends
 *  the visitor to a Supabase error page, so it stays hidden until enabled. */
export function githubOauthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GITHUB_OAUTH_ENABLED === "true";
}
