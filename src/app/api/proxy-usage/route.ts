import { randomUUID } from "node:crypto";

import { apiError, apiJson, parseBody } from "@/features/api/responses";
import { withRouteErrors } from "@/features/api/route-errors";
import { recordManagedUsage } from "@/features/billing/managed-usage";
import { makeProxyUsage } from "@/features/billing/proxy-usage-core";
import { proxyCallbackSecret, verifyProxyToken } from "@/features/billing/proxy";
import { logger } from "@/libs/log";
import { constantTimeEqual } from "@/utils/crypto";
import { z } from "zod";

const log = logger("api/proxy-usage");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recordProxyUsage = makeProxyUsage({
  verifyProxyToken,
  recordManagedUsage,
  newUsageId: randomUUID,
  warn: (message, meta) => log.warn(message, meta),
});

const usageSchema = z.object({
  token: z.string().min(1),
  // the proxy's stable per-call id. Dedups a retried report so it can't
  // double-bill. Optional only to tolerate a deploy-skew window with an older proxy.
  usageId: z.string().min(1).max(200).optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  // Prompt-cache counts, billed at their own rates. Bedrock reports `inputTokens`
  // EXCLUSIVE of both, so dropping them bills a cached call on its uncached input
  // alone. Defaulted so a gateway that predates them keeps validating.
  cacheReadTokens: z.number().int().min(0).default(0),
  cacheWriteTokens: z.number().int().min(0).default(0),
});

/**
 * Constant-time compare of the proxy's callback-auth secret header.
 *
 * This is a SEPARATE secret from the `tmpx_` token-signing key
 * (`TERRAGRAM_MODEL_PROXY_SECRET`, used by `verifyProxyToken`). Splitting the two
 * means leaking one doesn't grant both "pass this callback" AND "forge a `tmpx_`
 * token for any org" — previously a single leak did both. Falls back to the signing
 * secret when the dedicated callback secret isn't set, so existing deploys keep
 * working until the operator sets a distinct `TERRAGRAM_PROXY_CALLBACK_SECRET` on
 * both the Cloud and the proxy.
 */
let warnedFallback = false;

function secretOk(provided: string | null): boolean {
  if (!process.env.TERRAGRAM_PROXY_CALLBACK_SECRET && !warnedFallback) {
    warnedFallback = true;
    log.warn(
      "TERRAGRAM_PROXY_CALLBACK_SECRET is not set — falling back to the token-signing secret. Set a distinct callback secret on both Cloud and proxy to keep the two-secret isolation.",
    );
  }
  const secret = proxyCallbackSecret();
  if (!secret || !provided) return false;
  return constantTimeEqual(provided, secret);
}

/**
 * POST /api/proxy-usage — the EU Bedrock proxy reports real token usage after a
 * managed-model call. Double-authenticated: the shared proxy secret proves the
 * caller is our gateway, and the `tmpx_` token (re-verified here) carries the org
 * the run was minted for. We compute the marked-up cost, apply the allowance, and
 * record the metered overage — the money meter (D5). The answer carries `overCap`
 * (cycle spend including this call has reached the cap), which is how the gateway
 * learns to stop honouring the org's still-valid tokens. The decisions — expiry
 * grace, no per-org rate limit, the answer's shape — live in `proxy-usage-core.ts`.
 *
 * The header name is the gateway's (infraweaver-proxy sends
 * `x-infraweaver-proxy-secret`), not this product's: under any other name every
 * report is a 401 the gateway does not retry, so managed calls go unmetered.
 */
async function handlePost(request: Request) {
  if (!secretOk(request.headers.get("x-infraweaver-proxy-secret"))) {
    return apiError(401, "invalid_proxy_secret");
  }

  const body = await parseBody(request, usageSchema);
  if (!body.ok) return body.response;

  const result = await recordProxyUsage(body.data);
  return result.ok ? apiJson(result.body) : apiError(result.status, result.code);
}

export const POST = withRouteErrors(handlePost);
