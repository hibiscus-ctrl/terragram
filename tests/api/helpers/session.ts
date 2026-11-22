/**
 * Real Supabase session minting for the seeded suites.
 *
 * Flow: GoTrue admin `createUser` (confirmed) → `generateLink` (magiclink) →
 * GET /auth/confirm?token_hash=…&type=magiclink against the test server, which
 * runs the production sign-in path (verifyOtp + provisioning) and answers with
 * the session cookies.
 */
import assert from "node:assert/strict";

import { api, REDIRECT } from "./client.ts";
import type { Admin } from "./seed.ts";

/** Create a confirmed auth user with no password (magic-link only). */
export async function createAuthUser(admin: Admin, email: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw new Error(`createUser failed: ${created.error.message}`);
  return created.data.user.id;
}

/**
 * Sign the user in through the real /auth/confirm flow and return the Cookie
 * header for subsequent requests, plus the redirect target the app chose.
 */
export async function signIn(
  admin: Admin,
  email: string,
): Promise<{ cookie: string; landedAt: string }> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw new Error(`generateLink failed: ${link.error.message}`);
  const tokenHash = link.data.properties?.hashed_token;
  assert.ok(tokenHash, "generateLink returned a hashed_token");

  const res = await api()
    .get(`/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink`)
    .redirects(0);
  assert.ok(REDIRECT.includes(res.status), `confirm redirects (got ${res.status})`);

  const raw = res.headers["set-cookie"] as unknown;
  const setCookies: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const jar = setCookies.map((c) => c.split(";")[0] ?? "").filter((c) => c.includes("="));
  assert.ok(
    jar.some((c) => c.startsWith("sb-")),
    `confirm set session cookies (got: ${jar.map((c) => c.split("=")[0]).join(", ") || "none"})`,
  );
  return { cookie: jar.join("; "), landedAt: String(res.headers.location ?? "") };
}
