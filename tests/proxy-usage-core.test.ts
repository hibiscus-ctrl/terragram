import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ManagedUsageResult } from "../src/features/billing/managed-usage.ts";
import type { TokenUsage } from "../src/features/billing/model-cost.ts";
import {
  makeProxyUsage,
  PROXY_USAGE_EXPIRY_GRACE_MS,
  type ProxyUsageBody,
} from "../src/features/billing/proxy-usage-core.ts";
import type { ProxyTokenClaims } from "../src/features/billing/proxy.ts";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const RESULT: ManagedUsageResult = {
  costPence: 3,
  meteredPence: 0,
  alreadyRecorded: false,
  entitled: true,
  overCap: false,
};

const body = (over: Partial<ProxyUsageBody> = {}): ProxyUsageBody => ({
  token: "tmpx_p.s",
  product: "terragram",
  usageId: "call-1",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

/** A verifier that honours a token whose `exp` is `expMs`, judged at the `nowMs` it is given. */
function harness(expMs: number, result: ManagedUsageResult = RESULT) {
  const recorded: { org: string; usage: TokenUsage; usageId: string }[] = [];
  const warnings: string[] = [];
  const recordProxyUsage = makeProxyUsage({
    verifyProxyToken: (_token, nowMs) =>
      expMs < nowMs ? null : ({ org: "org-1", model: "sonnet" } as ProxyTokenClaims),
    recordManagedUsage: async (org, usage, usageId) => {
      recorded.push({ org, usage, usageId });
      return result;
    },
    newUsageId: () => "generated-id",
    warn: (message) => warnings.push(message),
  });
  return { recordProxyUsage, recorded, warnings };
}

describe("proxy usage core — the report's product", () => {
  it("refuses a report for another product with a logged 400, recording nothing", async () => {
    const h = harness(NOW + 60_000);
    const out = await h.recordProxyUsage(body({ product: "infraweaver" }), NOW);
    assert.deepEqual(out, { ok: false, status: 400, code: "wrong_product" });
    assert.equal(h.recorded.length, 0);
    assert.deepEqual(h.warnings, ["usage report refused — it is not for this product"]);
  });

  it("refuses a report that names no product", async () => {
    const h = harness(NOW + 60_000);
    const out = await h.recordProxyUsage(body({ product: undefined }), NOW);
    assert.deepEqual(out, { ok: false, status: 400, code: "product_required" });
    assert.equal(h.recorded.length, 0);
  });
});

describe("proxy usage core", () => {
  it("bills a report that arrives just after the token expired, inside the grace window", async () => {
    // A call started just before `exp` reports just after it; the gateway does not
    // retry a 4xx, so refusing it would leave the call unbilled.
    const h = harness(NOW - 10 * 60_000);
    const out = await h.recordProxyUsage(body(), NOW);
    assert.equal(out.ok, true);
    assert.equal(h.recorded.length, 1);
  });

  it("refuses a token expired for longer than the grace window", async () => {
    const h = harness(NOW - PROXY_USAGE_EXPIRY_GRACE_MS - 1);
    const out = await h.recordProxyUsage(body(), NOW);
    assert.deepEqual(out, { ok: false, status: 401, code: "invalid_or_expired_proxy_token" });
    assert.equal(h.recorded.length, 0);
  });

  it("records every report for an org, with no per-org limit to get its own usage dropped", async () => {
    const h = harness(NOW + 60_000);
    for (let i = 0; i < 1_000; i++) {
      const out = await h.recordProxyUsage(body({ usageId: `call-${i}` }), NOW);
      assert.equal(out.ok, true);
    }
    assert.equal(h.recorded.length, 1_000);
  });

  it("passes cache tokens through and falls back to the token's model", async () => {
    const h = harness(NOW + 60_000);
    await h.recordProxyUsage(body({ cacheReadTokens: 7, cacheWriteTokens: 3 }), NOW);
    assert.deepEqual(h.recorded[0]?.usage, {
      model: "sonnet",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
    });
  });

  it("generates an id for a report without one, and flags the old gateway", async () => {
    const h = harness(NOW + 60_000);
    await h.recordProxyUsage(body({ usageId: undefined }), NOW);
    assert.equal(h.recorded[0]?.usageId, "generated-id");
    assert.equal(h.warnings.length, 1);
  });

  it("answers overCap so the gateway can stop honouring the org's tokens", async () => {
    const h = harness(NOW + 60_000, { ...RESULT, overCap: true });
    const out = await h.recordProxyUsage(body(), NOW);
    assert.ok(out.ok);
    assert.equal(out.body.overCap, true);
  });
});
