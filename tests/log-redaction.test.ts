import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactSecrets, registerTokenPrefix } from "@infraweaver-io/core/redact";

/**
 * The masking is `@infraweaver-io/core`'s, so its correctness is that package's
 * business. What is Terragram's business is that the shapes THIS product mints
 * are covered — the `tmpx_` gateway token above all, because the failure path
 * that logs it (a gateway error carrying the request it failed on) is the one
 * place a credential can reach a log line here.
 *
 * `src/libs/log.ts` registers the prefix at import; registering again is
 * idempotent, and doing it here keeps the test honest when run in isolation.
 */
registerTokenPrefix("tmpx_");

describe("terragram token shapes", () => {
  it("masks a minted tmpx_ gateway token by shape, never having seen its value", () => {
    const line = "POST https://proxy.example/v1/messages failed: 401 {\"authorization\":\"Bearer tmpx_9f8e7d6c5b4a3210.sig\"}";
    const out = redactSecrets(line);
    assert.ok(!out.includes("tmpx_9f8e7d6c5b4a3210"), out);
    assert.ok(out.includes("proxy.example"), "the diagnosis itself survives");
  });

  it("masks a bare bearer token in a thrown request dump", () => {
    const out = redactSecrets("headers: { authorization: 'Bearer ghu_16C7e42F292c6912E7710c838347Ae178B4a' }");
    assert.ok(!out.includes("ghu_16C7e42F292c6912E7710c838347Ae178B4a"), out);
  });

  it("masks a credential-named JSON property whatever the value looks like", () => {
    const out = redactSecrets('{"access_token":"plain-looking-value","login":"octocat"}');
    assert.ok(!out.includes("plain-looking-value"), out);
    assert.ok(out.includes("octocat"), "non-secret fields are left readable");
  });

  it("leaves an ordinary message untouched", () => {
    const line = "read-diagram failed: Error: managed inference returned an unusable diagram reading";
    assert.equal(redactSecrets(line), line);
  });
});
