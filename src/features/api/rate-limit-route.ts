import { headers } from "next/headers";

import { apiError } from "@/features/api/responses";
import { pickTrustedIp, rateLimit, retryAfterLabel } from "@/libs/rate-limit";

/**
 * Per-route rate-limiting helpers for the Action-facing API. The dashboard server
 * actions already throttle their own mutations; these cover the unauthenticated /
 * credentialed POST endpoints (report ingest, webhooks, token mint) that the scan
 * flagged as floodable. Backed by {@link rateLimit}: the shared Postgres counter when
 * service-role credentials are set, the in-process one otherwise.
 */

/** Number of trusted proxy hops between this app and the client (default 1 — Railway's
 *  edge). Override with `RATE_LIMIT_TRUSTED_PROXIES` if more proxies sit in front. */
function trustedProxyHops(): number {
  const raw = Number(process.env.RATE_LIMIT_TRUSTED_PROXIES);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * Client IP for rate-limit keying, derived from a TRUSTED hop — see
 * {@link pickTrustedIp}. Keying on the leftmost `x-forwarded-for` would let a client
 * rotate a spoofed IP per request and evade the per-IP cap, so we take the hop our own
 * proxy added (`trustedProxyHops()` in from the right).
 */
export function clientIp(request: Request): string {
  return pickTrustedIp(
    request.headers.get("x-forwarded-for"),
    request.headers.get("x-real-ip"),
    trustedProxyHops(),
  );
}

/** {@link clientIp} for SERVER ACTIONS, which have no `Request` — reads the same
 *  forwarded headers from the request context. Pre-auth actions (login/signup/SSO)
 *  key their limiter on this because there is no user id yet. */
export async function actionClientIp(): Promise<string> {
  const h = await headers();
  return pickTrustedIp(h.get("x-forwarded-for"), h.get("x-real-ip"), trustedProxyHops());
}

/**
 * Consume one unit against `key`. Returns a ready-to-return 429 response once the
 * window is exhausted, or `null` to continue. Use:
 *
 *   const limited = await rateLimited(`report:${orgId}`, { limit: 120, windowMs: 60_000 });
 *   if (limited) return limited;
 */
export async function rateLimited(
  key: string,
  opts: { limit: number; windowMs: number; failClosed?: boolean },
): Promise<ReturnType<typeof apiError> | null> {
  const result = await rateLimit(key, opts);
  if (result.ok) return null;
  return apiError(429, "rate_limited", {
    message: `Too many requests — retry in ${retryAfterLabel(result.retryAfterMs)}.`,
    retryAfterMs: result.retryAfterMs,
  });
}
