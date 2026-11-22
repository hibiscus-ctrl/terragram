// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { USAGE_PRODUCT } from "./managed-meter.ts";
import type { ManagedUsageResult } from "./managed-usage.ts";
import type { TokenUsage } from "./model-cost.ts";
import type { ProxyTokenClaims } from "./proxy.ts";

/**
 * The decision core of `POST /api/proxy-usage`, behind injected collaborators so
 * the token-expiry and rate-limit posture are unit-testable. The route has
 * already checked the gateway's callback secret and validated the body.
 */

/**
 * How long after its `exp` a `tmpx_` token is still accepted HERE.
 *
 * The usage report arrives AFTER the model call, so a call started just before
 * `exp` reports just after it — and the gateway does not retry a 4xx. Judged
 * against `Date.now()`, every such call went unbilled, and always using a
 * nearly-expired token made that a free-inference recipe. The window covers the
 * gateway Lambda's longest run (900s). This route is authenticated by the
 * callback secret; the token here only names the org, it does not authorise.
 */
export const PROXY_USAGE_EXPIRY_GRACE_MS = 15 * 60_000;

export type ProxyUsageBody = {
  token: string;
  /** The app the token was minted for; the gateway sends it so each Cloud can check a
   *  report reached the right one. Typed optional so a report lacking it is answered by
   *  name rather than as a malformed body. */
  product?: string | undefined;
  usageId?: string | undefined;
  model?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ProxyUsageDeps = {
  verifyProxyToken: (token: string, nowMs: number) => ProxyTokenClaims | null;
  recordManagedUsage: (
    orgId: string,
    usage: TokenUsage,
    usageId: string,
  ) => Promise<ManagedUsageResult>;
  newUsageId: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

export type ProxyUsageResult =
  | { ok: true; body: { ok: true } & ManagedUsageResult }
  | { ok: false; status: 401; code: "invalid_or_expired_proxy_token" }
  | { ok: false; status: 400; code: "product_required" | "wrong_product" };

export function makeProxyUsage(deps: ProxyUsageDeps) {
  // Deliberately no per-org rate limit: a limit keyed on the org the usage is
  // FOR lets that org get its own usage reports dropped — unbilled — by making
  // many tiny calls. The caller is our own gateway, proven by the callback secret.
  return async function recordProxyUsage(
    body: ProxyUsageBody,
    nowMs: number = Date.now(),
  ): Promise<ProxyUsageResult> {
    // One gateway serves several apps and reports to the Cloud of the token's product.
    // A report for another product, or one naming none, is refused before anything is
    // recorded: it would land on this app's meter and bill this app's org for someone
    // else's call. A logged 400, so a mis-routed gateway is seen.
    if (body.product !== USAGE_PRODUCT) {
      deps.warn("usage report refused — it is not for this product", {
        reported: body.product ?? null,
        expected: USAGE_PRODUCT,
        usageId: body.usageId ?? null,
      });
      return {
        ok: false,
        status: 400,
        code: body.product === undefined ? "product_required" : "wrong_product",
      };
    }

    const claims = deps.verifyProxyToken(body.token, nowMs - PROXY_USAGE_EXPIRY_GRACE_MS);
    if (!claims) return { ok: false, status: 401, code: "invalid_or_expired_proxy_token" };

    // dedup on the proxy's per-call id. A current proxy always sends one; tolerate
    // an older one by falling back to a random id (that single call just isn't
    // retry-idempotent) and flag it so an un-updated proxy is noticed.
    const usageId = body.usageId ?? deps.newUsageId();
    if (!body.usageId) {
      deps.warn("report missing usageId — idempotency disabled for this call", { org: claims.org });
    }

    const result = await deps.recordManagedUsage(
      claims.org,
      {
        model: body.model ?? claims.model,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        cacheReadTokens: body.cacheReadTokens,
        cacheWriteTokens: body.cacheWriteTokens,
      },
      usageId,
    );

    if (!result.entitled) {
      // the run's token was minted while entitled, but the org has since downgraded
      // / opted out. We accepted the report (200, so the proxy doesn't retry) but recorded
      // and metered nothing. Logged so a surprising drop in managed revenue is traceable.
      deps.warn("org no longer entitled — usage not billed", { org: claims.org });
    }

    if (result.overCap) {
      // Recorded (the consumption happened), but the org has crossed its cap: new
      // mints are already refused, and the gateway refuses the org's older tokens
      // once it reads this answer.
      deps.warn("org over managed spend cap", { org: claims.org });
    }

    return { ok: true, body: { ok: true, ...result } };
  };
}
