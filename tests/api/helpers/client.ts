// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared plumbing for the HTTP API contract suite (tests/api/).
 *
 * These tests run against a REAL server (`npm run test:api` boots `next dev` on
 * port 3100 with .env.test layered over .env.local) because route handlers cannot
 * be imported under `node --test` — `next/server` has no export condition plain
 * Node resolves (see tests/route-auth-posture.test.ts). supertest against a base
 * URL is the only handler-level seam that exists.
 *
 * SKIPPED BY DEFAULT: plain `npm test` loads no env files, so `API_TEST_BASE_URL`
 * is unset and every suite here self-skips. Run deliberately:
 *
 *     npm run test:api
 *
 * SAFETY: unseeded cases send requests that terminate before any write (bad
 * signatures, unknown event types, signed-out callers). Seeded cases create
 * throwaway `apitest-terragram-*` users and delete them — and everything their
 * sign-in provisioned — in `after()`. See helpers/seed.ts.
 */
import { createHmac, randomInt } from "node:crypto";

import supertest from "supertest";

const BASE_URL = process.env.API_TEST_BASE_URL ?? "";

/** Gate for every suite in tests/api/ — false under plain `npm test`. */
export const CONFIGURED = Boolean(BASE_URL);

/** The test server's own origin — where the proxy's route guard redirects to
 *  (it clones the request URL rather than using SITE_URL). */
export const BASE_ORIGIN = BASE_URL ? new URL(BASE_URL).origin : "";

// The runner is launched with only .env.test (see test:api:run); the server gets
// .env.local because Next loads it from disk itself. The seeded suites need the
// service-role credentials from .env.local in THIS process too, so pull them in
// here — never under plain `npm test` (CONFIGURED is false there), and without
// overriding any .env.test value (loadEnvFile keeps already-set vars).
if (CONFIGURED && !process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local (e.g. CI without secrets): the seeded suites self-skip.
  }
}

/** The origin every redirect must stay on — the server's own `SITE_URL`. */
export const SITE_ORIGIN = new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").origin;

export function api(): ReturnType<typeof supertest> {
  return supertest(BASE_URL);
}

/**
 * Compile page routes before anything asserts on them. `start-server-and-test`
 * opens the gate as soon as `/api/health` answers, which compiles in
 * milliseconds; a page under `(app)/` has compiled nothing yet, and a cold first
 * request can answer with a transient error. Every outcome is ignored — this only
 * forces compilation; the real assertions still run afterwards.
 */
export async function warmPageRoutes(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await api().get(path).redirects(0).timeout(120_000);
    } catch {
      // Any answer, or a timeout, means the route compiled far enough.
    }
  }
}

/** `t=<unix>,v1=<hex>` Stripe webhook signature header over the raw body. */
export function stripeSignature(
  rawBody: string,
  secret: string = process.env.STRIPE_WEBHOOK_SECRET ?? "",
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/**
 * A fresh private IP per call. The rate limiter is in-process fixed-window with
 * no reset hook, so per-IP keys must not collide across tests or back-to-back
 * runs inside one window. `clientIp` trusts the rightmost x-forwarded-for hop,
 * which the test client controls when nothing proxies the connection.
 */
export function uniqueIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(254) + 1}`;
}

/** Every 3xx a route handler or the proxy may answer a redirect with. */
export const REDIRECT = [302, 303, 307, 308];
