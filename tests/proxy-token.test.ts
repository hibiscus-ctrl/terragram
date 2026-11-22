import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  isModelProxyConfigured,
  mintProxyToken,
  proxyCallbackSecret,
  verifyProxyToken,
} from "../src/features/billing/proxy.ts";

/**
 * The `tmpx_` token is the credential that authorises real Bedrock spend against an
 * org, and it carries the remaining budget the gateway enforces for the whole TTL.
 * It had no tests at all. These cover the properties that actually matter: an
 * unforgeable signature, a payload that cannot be edited after signing, an expiry
 * that is enforced, a scope that cannot be replayed from another feature, and a
 * verifier that fails CLOSED — returning null — on every malformed input rather
 * than throwing into the caller.
 */

const SECRET = "test-signing-secret";
const OTHER_SECRET = "a-different-secret";
const URL = "https://proxy.example.test";

const envBackup: Record<string, string | undefined> = {};
const KEYS = ["TERRAGRAM_MODEL_PROXY_SECRET", "TERRAGRAM_MODEL_PROXY_URL"];

beforeEach(() => {
  for (const k of KEYS) envBackup[k] = process.env[k];
  process.env.TERRAGRAM_MODEL_PROXY_SECRET = SECRET;
  process.env.TERRAGRAM_MODEL_PROXY_URL = URL;
});

afterEach(() => {
  for (const k of KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

/** Re-sign an arbitrary payload the way the mint does — an attacker who holds the
 *  secret. Used to prove the payload checks are real and not signature side-effects. */
function signed(payload: object, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `tmpx_${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe("isModelProxyConfigured", () => {
  it("needs both the URL and the secret", () => {
    assert.equal(isModelProxyConfigured(), true);
    delete process.env.TERRAGRAM_MODEL_PROXY_URL;
    assert.equal(isModelProxyConfigured(), false);
    process.env.TERRAGRAM_MODEL_PROXY_URL = URL;
    delete process.env.TERRAGRAM_MODEL_PROXY_SECRET;
    assert.equal(isModelProxyConfigured(), false);
  });
});

describe("proxyCallbackSecret", () => {
  afterEach(() => {
    delete process.env.TERRAGRAM_PROXY_CALLBACK_SECRET;
  });

  it("prefers the dedicated callback secret", () => {
    process.env.TERRAGRAM_PROXY_CALLBACK_SECRET = "callback-only";
    assert.equal(proxyCallbackSecret(), "callback-only");
  });

  it("falls back to the signing secret so an unsplit deployment keeps working", () => {
    // The split exists so leaking one secret does not grant BOTH "pass this
    // callback" and "mint a token for any org". The fallback is a migration
    // affordance, not the intended end state.
    assert.equal(proxyCallbackSecret(), SECRET);
  });

  it("is undefined when neither is configured", () => {
    delete process.env.TERRAGRAM_MODEL_PROXY_SECRET;
    assert.equal(proxyCallbackSecret(), undefined);
  });
});

describe("mintProxyToken", () => {
  it("refuses to mint when the proxy is not configured", () => {
    delete process.env.TERRAGRAM_MODEL_PROXY_SECRET;
    assert.throws(() => mintProxyToken("org-1"), /not configured/);
  });

  it("round-trips the claims it was given", () => {
    const minted = mintProxyToken("org-1", "claude-opus-5", 2_500);
    const claims = verifyProxyToken(minted.token);
    assert.equal(claims?.org, "org-1");
    assert.equal(claims?.model, "claude-opus-5");
    assert.equal(claims?.budget_pence, 2_500);
    assert.equal(claims?.scope, "model-proxy");
    assert.equal(claims?.product, "terragram");
    assert.equal(minted.endpoint, URL);
  });

  it("records a null model and budget when none was chosen", () => {
    const claims = verifyProxyToken(mintProxyToken("org-1").token);
    assert.equal(claims?.model, null);
    assert.equal(claims?.budget_pence, null);
  });

  it("expires an hour out, and says so in expires_at", () => {
    const before = Date.now();
    const minted = mintProxyToken("org-1");
    const claims = verifyProxyToken(minted.token);
    const ttlMs = (claims?.exp ?? 0) * 1000 - before;
    assert.ok(ttlMs > 3_590_000 && ttlMs <= 3_600_000, `ttl was ${ttlMs}ms`);
    assert.equal(new Date(minted.expires_at).getTime(), (claims?.exp ?? 0) * 1000);
  });

  it("carries a zero budget as zero, not as 'no cap'", () => {
    // `?? null` on a 0 budget would read as "no cap known" at the gateway and let a
    // capped-out org keep spending for the token's whole hour.
    const claims = verifyProxyToken(mintProxyToken("org-1", null, 0).token);
    assert.equal(claims?.budget_pence, 0);
  });
});

describe("verifyProxyToken — what it must reject", () => {
  it("rejects a token signed with a different secret", () => {
    assert.equal(verifyProxyToken(signed({ org: "o", model: null, scope: "model-proxy", product: "terragram", exp: future() }, OTHER_SECRET)), null);
  });

  it("rejects an edited payload", () => {
    // The whole point of signing: raise your own budget and the signature stops matching.
    const token = mintProxyToken("org-1", null, 100).token;
    const [payload, signature] = token.slice("tmpx_".length).split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.budget_pence = 9_999_999;
    const edited = Buffer.from(JSON.stringify(claims)).toString("base64url");
    assert.equal(verifyProxyToken(`tmpx_${edited}.${signature}`), null);
  });

  it("rejects an expired token", () => {
    const minted = mintProxyToken("org-1");
    assert.ok(verifyProxyToken(minted.token));
    assert.equal(verifyProxyToken(minted.token, Date.now() + 3_601_000), null);
  });

  it("rejects a token minted for another purpose", () => {
    // Scope pinning: a validly-signed token from some other feature must not be
    // replayable as spending authority.
    assert.equal(verifyProxyToken(signed({ org: "o", model: null, scope: "password-reset", exp: future() })), null);
  });

  it("rejects claims that are structurally wrong", () => {
    assert.equal(verifyProxyToken(signed({ org: "", model: null, scope: "model-proxy", product: "terragram", exp: future() })), null);
    assert.equal(verifyProxyToken(signed({ model: null, scope: "model-proxy", product: "terragram", exp: future() })), null);
    assert.equal(verifyProxyToken(signed({ org: "o", model: null, scope: "model-proxy", product: "terragram", exp: "soon" })), null);
  });

  it("rejects a token with no product claim, or one minted for the other product", () => {
    // The gateway serves both products on one signing secret, and the claim is what
    // keeps one product's token from being spent against the other's meter.
    const claims = { org: "o", model: null, scope: "model-proxy", exp: future() };
    assert.equal(verifyProxyToken(signed(claims)), null);
    assert.equal(verifyProxyToken(signed({ ...claims, product: "infraweaver" })), null);
    assert.equal(verifyProxyToken(signed({ ...claims, product: "other" })), null);
    assert.ok(verifyProxyToken(signed({ ...claims, product: "terragram" })));
  });

  it("rejects anything not carrying the prefix", () => {
    const body = mintProxyToken("org-1").token.slice("tmpx_".length);
    assert.equal(verifyProxyToken(body), null);
    assert.equal(verifyProxyToken(`bearer_${body}`), null);
    assert.equal(verifyProxyToken(""), null);
  });

  it("rejects malformed shapes without throwing", () => {
    for (const token of [
      "tmpx_",
      "tmpx_.",
      "tmpx_onlypayload",
      "tmpx_.signature-with-no-payload",
      "tmpx_not-base64!!.sig",
      `tmpx_${Buffer.from("not json").toString("base64url")}.sig`,
    ]) {
      assert.equal(verifyProxyToken(token), null, `expected null for ${JSON.stringify(token)}`);
    }
  });

  it("returns null rather than throwing on a multi-byte signature", () => {
    // Regression: the comparison checked STRING length and handed timingSafeEqual
    // UTF-8 BYTES, so a signature with one multi-byte character matched on length
    // and then threw RangeError out of a function documented to return null — the
    // callback answered 500 instead of 401.
    const token = mintProxyToken("org-1").token;
    const [payload, signature] = token.slice("tmpx_".length).split(".");
    const multibyte = `é${signature!.slice(1)}`;
    assert.equal(multibyte.length, signature!.length, "the forgery must match on string length");
    assert.equal(verifyProxyToken(`tmpx_${payload}.${multibyte}`), null);
  });

  it("fails closed when the verifying secret is gone", () => {
    const token = mintProxyToken("org-1").token;
    delete process.env.TERRAGRAM_MODEL_PROXY_SECRET;
    assert.equal(verifyProxyToken(token), null);
  });

  it("stops honouring tokens after the secret is rotated", () => {
    const token = mintProxyToken("org-1").token;
    process.env.TERRAGRAM_MODEL_PROXY_SECRET = OTHER_SECRET;
    assert.equal(verifyProxyToken(token), null);
  });
});

describe("verifyProxyToken — the deploy-skew allowance", () => {
  it("still accepts a token minted before the spend cap shipped", () => {
    // Tokens without `budget_pence` are in flight during a deploy; they must verify.
    const claims = verifyProxyToken(signed({ org: "o", model: null, scope: "model-proxy", product: "terragram", exp: future() }));
    assert.equal(claims?.org, "o");
    assert.equal(claims?.budget_pence, undefined);
  });
});
