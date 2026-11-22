import { createHmac } from "node:crypto";

import { z } from "zod";

import { USAGE_PRODUCT } from "@/features/billing/managed-meter";
import { constantTimeEqual } from "@/utils/crypto";

/**
 * Managed-model proxy credential mint.
 *
 * The sovereign-execution model keeps cloud/model creds in the customer's CI; the
 * one exception is the optional **managed-model** tier, where the engine asks the
 * Cloud for a short-lived credential to reach an EU model gateway. We mint a
 * scoped, HMAC-signed, expiring token here; the gateway (separate infra) verifies
 * it and meters consumption. No long-lived secret ever leaves the Cloud.
 */

const TOKEN_PREFIX = "tmpx_";

export type ProxyToken = { token: string; expires_at: string; endpoint: string };

/**
 * The secret the EU proxy authenticates its usage callback with.
 *
 * Here rather than in `/api/proxy-usage`, which is where the fallback chain used
 * to live. Both halves of the split are a property of this credential pair, and a
 * route that re-derived one of them was a second place to get the fallback wrong.
 * Falls back to the token-signing secret so a deployment that has not split them
 * yet keeps working — the split exists so that leaking one does not grant both
 * "pass this callback" AND "mint a token for any org".
 */
export function proxyCallbackSecret(): string | undefined {
  return (
    process.env.TERRAGRAM_PROXY_CALLBACK_SECRET ?? process.env.TERRAGRAM_MODEL_PROXY_SECRET
  );
}

export function isModelProxyConfigured(): boolean {
  return Boolean(process.env.TERRAGRAM_MODEL_PROXY_URL && process.env.TERRAGRAM_MODEL_PROXY_SECRET);
}

export function mintProxyToken(
  orgId: string,
  model?: string | null,
  budgetPence?: number,
): ProxyToken {
  const secret = process.env.TERRAGRAM_MODEL_PROXY_SECRET;
  const endpoint = process.env.TERRAGRAM_MODEL_PROXY_URL;
  if (!secret || !endpoint) throw new Error("model proxy not configured");

  const ttlSeconds = 3600;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const payload = Buffer.from(
    JSON.stringify({
      org: orgId,
      model: model ?? null,
      scope: "model-proxy",
      // Which product minted the token. The proxy and the other app sharing the
      // signing secret refuse a token without it, so usage lands on the right meter.
      product: USAGE_PRODUCT,
      // Mint time, in seconds. The gateway's spend-cap guard refuses an over-cap
      // org's tokens minted BEFORE it saw the cap crossed, and reads a token with
      // no `iat` as minted before — so without it, every fresh token after a
      // crossing is refused too, even once the cap is raised or a cycle starts.
      iat,
      exp,
      // Remaining managed budget this cycle at mint time (cap − spend, pence). The
      // gateway enforces it so the 1h TTL cannot outrun the spend cap: once it has
      // metered this much on this token's org it must stop serving, without waiting
      // for a Cloud round-trip. null = no cap known.
      budget_pence: budgetPence ?? null,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");

  return {
    token: `${TOKEN_PREFIX}${payload}.${signature}`,
    expires_at: new Date(exp * 1000).toISOString(),
    endpoint,
  };
}

/** The signed claims inside a `tmpx_` token. `scope` is pinned so a token minted
 *  for a different purpose can never be replayed against the model proxy.
 *  `budget_pence` is optional — tokens minted before the spend cap shipped are
 *  still in their TTL window during a deploy; they verify without it. `iat` is
 *  optional for the same reason. */
const proxyTokenClaimsSchema = z.object({
  org: z.string().min(1),
  model: z.string().nullable(),
  scope: z.literal("model-proxy"),
  product: z.literal(USAGE_PRODUCT),
  iat: z.number().optional(),
  exp: z.number(),
  budget_pence: z.number().nullable().optional(),
});

export type ProxyTokenClaims = z.infer<typeof proxyTokenClaimsSchema>;

/**
 * Verify a `tmpx_` token (HMAC signature + expiry + scope) and return its claims,
 * or null. The same `TERRAGRAM_MODEL_PROXY_SECRET` mints and verifies, so the
 * usage-report callback can re-derive the org a token was minted for without a DB
 * lookup — the EU proxy holds the same secret and verifies identically.
 */
export function verifyProxyToken(
  token: string,
  nowMs: number = Date.now(),
): ProxyTokenClaims | null {
  const secret = process.env.TERRAGRAM_MODEL_PROXY_SECRET;
  if (!secret) return null;
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  // Exactly two parts, as the gateway requires: `tmpx_<p>.<s>.anything` must not
  // verify as the same token.
  const parts = token.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = proxyTokenClaimsSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const claims = parsed.data;
  // Expiry is a runtime check, not a structural one — the schema only proves `exp`
  // is a number; whether it's in the past depends on `nowMs`.
  if (claims.exp * 1000 < nowMs) return null;
  return claims;
}
