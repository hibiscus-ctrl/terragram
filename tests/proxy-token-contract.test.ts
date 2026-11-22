/**
 * `tmpx_` token contract (contracts/proxy-token.json).
 *
 * Terragram mints the managed-model token in `src/features/billing/proxy.ts` and
 * the EU gateway verifies it in `infraweaver-proxy/src/token.ts`. The two share no
 * code, so the fixture does: the same secret, the same claims, the exact token
 * bytes. The gateway serves both products, so there is one wire format, and every
 * token carries a `product` claim. The file is a copy of the gateway's own fixture
 * with that one claim changed (`terragram` here, `infraweaver` there) and the token
 * re-signed to match; the last test re-reads the sibling checkout to prove nothing
 * else has drifted.
 *
 * When `../infraweaver-proxy` is checked out, a token minted HERE is also handed
 * to the gateway's real verifier. That is the assertion that matters most: it
 * fails the moment the two sides disagree, whatever the fixture says.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mintProxyToken, verifyProxyToken } from "../src/features/billing/proxy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const own = readFileSync(join(here, "..", "contracts", "proxy-token.json"), "utf8");
const contract = JSON.parse(own) as {
  secret: string;
  claims: {
    org: string;
    model: string;
    scope: "model-proxy";
    product: "terragram";
    iat: number;
    exp: number;
    budget_pence: number;
  };
  token: string;
};

const proxyDir = join(here, "..", "..", "infraweaver-proxy");

/** Mint and verify read their config from the environment; pin it for one call
 *  and restore whatever was there. */
function withProxyEnv<T>(fn: () => T): T {
  const keys = ["TERRAGRAM_MODEL_PROXY_SECRET", "TERRAGRAM_MODEL_PROXY_URL"] as const;
  const prev = keys.map((k) => process.env[k]);
  process.env.TERRAGRAM_MODEL_PROXY_SECRET = contract.secret;
  process.env.TERRAGRAM_MODEL_PROXY_URL = "https://proxy.invalid";
  try {
    return fn();
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  }
}

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.slice("tmpx_".length).split(".")[0] ?? "", "base64url").toString("utf8"),
  );

describe("proxy-token contract", () => {
  it("verifies the fixture token and recovers the claims it bills against", () => {
    const claims = withProxyEnv(() => verifyProxyToken(contract.token, contract.claims.exp * 1000 - 1));
    assert.ok(claims, "the gateway's fixture token does not verify here");
    assert.equal(claims.org, contract.claims.org);
    assert.equal(claims.model, contract.claims.model);
    assert.equal(claims.scope, contract.claims.scope);
    assert.equal(claims.product, "terragram");
    assert.equal(claims.exp, contract.claims.exp);
    assert.equal(claims.budget_pence, contract.claims.budget_pence);
  });

  it("rejects the fixture token under any other secret", () => {
    const claims = withProxyEnv(() => {
      process.env.TERRAGRAM_MODEL_PROXY_SECRET = `${contract.secret}x`;
      return verifyProxyToken(contract.token, contract.claims.exp * 1000 - 1);
    });
    assert.equal(claims, null);
  });

  it("mints every claim the gateway reads, in the fixture's key order", () => {
    // `iat` included: the gateway's spend-cap guard (infraweaver-proxy
    // src/spendCap.ts) reads a token without it as minted before the cap was
    // crossed, so every fresh token after a crossing would be refused too.
    const minted = withProxyEnv(() =>
      mintProxyToken(contract.claims.org, contract.claims.model, contract.claims.budget_pence),
    );
    const decoded = payloadOf(minted.token);
    const expected = payloadOf(contract.token);
    // The payload is signed as bytes, so key order is part of the contract.
    assert.deepEqual(Object.keys(decoded), Object.keys(expected));
    assert.deepEqual({ ...decoded, iat: expected.iat, exp: expected.exp }, expected);
  });

  it("mints iat in whole seconds, one TTL before exp", () => {
    const before = Math.floor(Date.now() / 1000);
    const minted = withProxyEnv(() => mintProxyToken("org_contract_fixture", "claude-sonnet-5-5", 250));
    const after = Math.floor(Date.now() / 1000);
    const { iat, exp } = payloadOf(minted.token) as { iat: number; exp: number };
    assert.ok(Number.isInteger(iat) && iat >= before && iat <= after, `iat ${iat} is not now in seconds`);
    assert.equal(exp - iat, 3600);
  });

  it("rejects a token with extra dot-separated parts, as the gateway does", () => {
    const claims = withProxyEnv(() =>
      verifyProxyToken(`${contract.token}.extra`, contract.claims.exp * 1000 - 1),
    );
    assert.equal(claims, null);
  });

  it("a token minted here verifies under the gateway's own verifier", async (t) => {
    const verifier = join(proxyDir, "src", "token.ts");
    if (!existsSync(verifier)) return t.skip("../infraweaver-proxy not checked out");
    const { verifyProxyToken: gatewayVerify } = (await import(pathToFileURL(verifier).href)) as {
      verifyProxyToken: (
        token: unknown,
        secret: string | undefined,
        nowMs?: number,
      ) => Record<string, unknown> | null;
    };
    const minted = withProxyEnv(() => mintProxyToken("org_contract_fixture", "claude-sonnet-5-5", 250));
    const claims = gatewayVerify(minted.token, contract.secret);
    assert.ok(claims, "the gateway rejects a token Terragram minted");
    assert.equal(claims.org, "org_contract_fixture");
    assert.equal(claims.model, "claude-sonnet-5-5");
    assert.equal(gatewayVerify(minted.token, `${contract.secret}x`), null);
  });

  it("matches the sibling repo's copy in everything but the product", (t) => {
    let sibling: string;
    try {
      sibling = readFileSync(join(proxyDir, "contracts", "proxy-token.json"), "utf8");
    } catch {
      return t.skip("../infraweaver-proxy not checked out");
    }
    // The two copies cannot be byte-identical any more: the product claim differs, so
    // the signed token does too. Everything the gateway reads besides it must agree.
    const theirs = JSON.parse(sibling) as { secret: string; claims: Record<string, unknown> };
    const { product: ownProduct, ...ownClaims } = contract.claims;
    const { product: theirProduct, ...theirClaims } = theirs.claims;
    assert.equal(ownProduct, "terragram");
    assert.equal(theirProduct, "infraweaver");
    assert.equal(theirs.secret, contract.secret);
    assert.deepEqual(theirClaims, ownClaims);
  });
});
