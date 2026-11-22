/**
 * The model gateway's usage callback over HTTP.
 *
 * Double-authenticated: a shared secret header proves the caller is the gateway,
 * and the `tmpx_` token names the org that is billed. .env.test pins both secrets
 * on the test server (signing and callback deliberately DIFFERENT, so the split is
 * exercised) and the suite mints tokens with the same signing secret. The proxy
 * URL is never dialled.
 *
 * The only accepted report here is for an org id that does not exist, which
 * `recordManagedUsage` treats as not entitled: it records and meters nothing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { mintProxyToken } from "../../src/features/billing/proxy.ts";
import { api, CONFIGURED } from "./helpers/client.ts";
import { assertApiError, assertExactKeys } from "./helpers/shape.ts";

const CALLBACK_SECRET = process.env.TERRAGRAM_PROXY_CALLBACK_SECRET ?? "";
const READY =
  CONFIGURED &&
  Boolean(CALLBACK_SECRET) &&
  Boolean(process.env.TERRAGRAM_MODEL_PROXY_SECRET) &&
  Boolean(process.env.TERRAGRAM_MODEL_PROXY_URL);

const PATH = "/api/proxy-usage";

const report = (token: string, over: Record<string, unknown> = {}) => ({
  token,
  product: "terragram",
  usageId: `apitest-terragram-${randomUUID()}`,
  model: "claude-sonnet-5-5",
  inputTokens: 10,
  outputTokens: 5,
  ...over,
});

/** A token for an org that does not exist — accepted, never billed. */
const ghostToken = () => mintProxyToken(randomUUID(), "claude-sonnet-5-5", 100).token;

describe("POST /api/proxy-usage", { skip: !READY }, () => {
  it("PU-N1: no secret header is 401 before the body is read", async () => {
    assertApiError(await api().post(PATH).send(report(ghostToken())), 401, "invalid_proxy_secret");
  });

  it("PU-N2: a wrong secret is 401", async () => {
    const res = await api()
      .post(PATH)
      .set("x-infraweaver-proxy-secret", `${CALLBACK_SECRET}x`)
      .send(report(ghostToken()));
    assertApiError(res, 401, "invalid_proxy_secret");
  });

  it("PU-N3: the TOKEN-signing secret does not pass as the callback secret", async () => {
    // The split exists so that leaking one does not grant both.
    const res = await api()
      .post(PATH)
      .set("x-infraweaver-proxy-secret", process.env.TERRAGRAM_MODEL_PROXY_SECRET ?? "")
      .send(report(ghostToken()));
    assertApiError(res, 401, "invalid_proxy_secret");
  });

  it("PU-N4: a forged or expired token is 401 even with the right secret", async () => {
    for (const token of ["tmpx_forged.signature", "not-a-token", `${ghostToken()}x`]) {
      const res = await api().post(PATH).set("x-infraweaver-proxy-secret", CALLBACK_SECRET).send(report(token));
      assertApiError(res, 401, "invalid_or_expired_proxy_token");
    }
  });

  it("PU-N5: a malformed report is 400", async () => {
    for (const body of [{}, report(ghostToken(), { inputTokens: -1 }), report(ghostToken(), { outputTokens: 1.5 })]) {
      const res = await api().post(PATH).set("x-infraweaver-proxy-secret", CALLBACK_SECRET).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it("PU-N6: a report for another product, or naming none, is a 400 and records nothing", async () => {
    for (const [product, code] of [
      ["infraweaver", "wrong_product"],
      [undefined, "product_required"],
    ] as const) {
      const res = await api()
        .post(PATH)
        .set("x-infraweaver-proxy-secret", CALLBACK_SECRET)
        .send(report(ghostToken(), { product }));
      assertApiError(res, 400, code);
    }
  });

  it("PU-P1: a valid report for an org that is not entitled is accepted and billed nothing", async () => {
    const res = await api().post(PATH).set("x-infraweaver-proxy-secret", CALLBACK_SECRET).send(report(ghostToken()));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertExactKeys(res.body, ["ok", "costPence", "meteredPence", "alreadyRecorded", "entitled", "overCap"]);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.entitled, false);
    assert.equal(res.body.meteredPence, 0);
    assert.equal(res.body.overCap, false);
  });

  it("PU-C1: reads the secret only under the header name the gateway sends", async () => {
    // infraweaver-proxy sends `x-infraweaver-proxy-secret` (see
    // tests/proxy-usage-contract.test.ts); the right secret under any other name
    // must not pass.
    const res = await api()
      .post(PATH)
      .set("x-terragram-proxy-secret", CALLBACK_SECRET)
      .send(report(ghostToken()));
    assertApiError(res, 401, "invalid_proxy_secret");
  });

  it("PU-C2: prices the prompt-cache counts the gateway reports", async () => {
    // Bedrock reports cache tokens EXCLUSIVE of inputTokens, so a cache-only call
    // still costs something. Priced even for an unentitled org (nothing is billed).
    const res = await api()
      .post(PATH)
      .set("x-infraweaver-proxy-secret", CALLBACK_SECRET)
      .send(report(ghostToken(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.costPence > 0, `a million cache reads priced at ${res.body.costPence}p`);
  });
});
