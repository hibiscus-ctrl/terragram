/**
 * Rate limiter (fixed-window) for server actions + Action-facing routes.
 *
 * Two backends behind one async `rateLimit(key, opts)` seam:
 *
 *   - **Postgres** (`consume_rate_limit`) whenever service-role credentials are
 *     configured. One statement per check, so replicas racing on a key serialize on
 *     a row lock rather than each keeping a private count.
 *   - **In-process** otherwise, and as the degraded fallback for non-`failClosed`
 *     callers. Correct where one process IS the service (local dev, previews).
 *
 * WHY. The in-memory counter was exact on one container and silently wrong on two:
 * N replicas multiply every limit by N, and a restart resets every window. Nothing
 * fails loudly at the moment of scaling; the protection just thins. Keeping the
 * state in the database makes the limit a property of the service.
 *
 * `consume_rate_limit` and its `rate_limit_buckets` table are SHARED with
 * Infraweaver Cloud (same Supabase project; that app's migration owns them). Its
 * keys are free text, and both apps use the same key names (`stripe-webhook:<ip>`,
 * `csp-report:<ip>` …), so every key is sent prefixed `terragram:` — without it the
 * two apps would drain each other's buckets. Expired rows are pruned by the owning
 * app's drain job.
 *
 * Callers `await` it; everything runs in an async server action / route handler.
 */

import { logger } from "./log.ts";

const log = logger("rate-limit");

/** Namespace for this app's keys in the shared bucket table. */
const SHARED_KEY_PREFIX = "terragram:";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const SWEEP_THRESHOLD = 5_000;

export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

function sweep(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** The in-process fixed-window check. */
function inMemoryRateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true };
  }
  if (bucket.count >= opts.limit) {
    return { ok: false, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { ok: true };
}

/**
 * Whether the shared store is usable. A deploy without service-role credentials
 * (local dev, a preview build) keeps the in-process counter. Reads the secret
 * through its legacy alias exactly as `supabase-admin.ts` does — checking one name
 * alone would silently revert a deploy that sets only the other.
 */
function sharedStoreConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim(),
  );
}

/**
 * The shared fixed-window check — one `consume_rate_limit` round trip.
 *
 * Returns null when the store could not answer, leaving the decision to the
 * caller's `failClosed` preference rather than silently allowing.
 */
async function sharedRateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): Promise<RateLimitResult | null> {
  try {
    const { supabaseAdminClient } = await import("@/libs/supabase/supabase-admin");
    const { data, error } = await supabaseAdminClient.rpc("consume_rate_limit", {
      p_key: `${SHARED_KEY_PREFIX}${key}`,
      p_limit: opts.limit,
      p_window_ms: opts.windowMs,
    });
    if (error) return null;
    const row = data?.[0];
    if (!row) return null;
    return row.allowed
      ? { ok: true }
      : { ok: false, retryAfterMs: row.retry_after_ms ?? opts.windowMs };
  } catch {
    return null;
  }
}

/**
 * Consume one unit against `key`. Returns `{ ok: false, retryAfterMs }` once the
 * window's `limit` is exhausted, until the window rolls over.
 *
 * When the shared store cannot answer (the DB is unreachable, the RPC errors), an
 * ordinary caller falls back to the in-process counter — degraded but still
 * bounded, and better than refusing service over a limiter. A `failClosed` caller
 * is DENIED instead: there, "we cannot tell how many times you have asked" must not
 * read as "go ahead".
 */
export async function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number; failClosed?: boolean },
): Promise<RateLimitResult> {
  if (!sharedStoreConfigured()) return inMemoryRateLimit(key, opts);

  const shared = await sharedRateLimit(key, opts);
  if (shared) return shared;

  if (opts.failClosed) {
    log.error("shared store unavailable, failing closed", { key });
    return { ok: false, retryAfterMs: opts.windowMs };
  }
  return inMemoryRateLimit(key, opts);
}

/**
 * Pick the trustworthy client IP for rate-limit keying from the forwarded headers
 * Pure, so it's unit-testable apart from the `Request`-bound `clientIp` wrapper.
 *
 * A proxy APPENDS the peer it received the connection from to the RIGHT of
 * `x-forwarded-for`; the leftmost entries are attacker-supplied. We take the hop our
 * own trusted proxy added — `trustedHops` (default 1) positions in from the right — so a
 * client can't rotate a spoofed leftmost IP to dodge the per-IP cap. Falls back to
 * `x-real-ip` (which the trusted proxy overwrites) then `"unknown"`.
 */
export function pickTrustedIp(
  forwardedFor: string | null,
  realIp: string | null,
  trustedHops: number,
): string {
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - Math.max(1, trustedHops));
      const ip = parts[idx];
      if (ip) return ip;
    }
  }
  return realIp ?? "unknown";
}

/** Human-friendly "try again in …" string for a retry-after duration. */
export function retryAfterLabel(retryAfterMs: number): string {
  const mins = Math.ceil(retryAfterMs / 60_000);
  if (mins <= 1) return "a minute";
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.ceil(mins / 60);
  return `${hrs} hour${hrs === 1 ? "" : "s"}`;
}
