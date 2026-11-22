// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The usage-callback half of the gateway contract.
 *
 * After every managed call the EU gateway (`infraweaver-proxy/src/usage.ts`)
 * POSTs the token counts back to `/api/proxy-usage`, authenticated by a shared
 * secret HEADER, and reads `overCap` out of the reply to enforce the spend cap for
 * the rest of the token's TTL. The header name, the body fields and that reply
 * field are a wire contract the two repos share no code for. These tests read the
 * gateway's source from the sibling checkout and skip when it is absent.
 *
 * Source-level on this side too: the route imports `next/server`, which plain
 * Node cannot load (see route-auth-posture.test.ts). The HTTP half is
 * tests/api/proxy-usage.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "..", "src", "app", "api", "proxy-usage", "route.ts"), "utf8");
const gatewayUsage = join(here, "..", "..", "infraweaver-proxy", "src", "usage.ts");
const gateway = existsSync(gatewayUsage) ? readFileSync(gatewayUsage, "utf8") : null;
const SKIP = gateway ? false : "../infraweaver-proxy not checked out";

/** The keys of the object literal the gateway serialises as the report body. */
function gatewayBodyKeys(source: string): string[] {
  const literal = /body = JSON\.stringify\(\{([\s\S]*?)\}\)/.exec(source);
  assert.ok(literal, "could not find the report body in the gateway's usage.ts");
  return String(literal[1])
    .split(",")
    .map((k) => k.trim().split(":")[0]?.trim() ?? "")
    .filter(Boolean);
}

/** The keys `usageSchema` accepts on this side. */
function routeSchemaKeys(source: string): string[] {
  const schema = /const usageSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(source);
  assert.ok(schema, "could not find usageSchema in the proxy-usage route");
  return [...String(schema[1]).matchAll(/^\s+(\w+):/gm)].map((m) => String(m[1]));
}

describe("proxy usage callback contract", { skip: SKIP }, () => {
  it("reads the secret from the header the gateway sends", () => {
    // Under any other name every usage report is a 401, which the gateway does
    // not retry: managed calls are served and never metered.
    const sent = /"(x-[\w-]+-proxy-secret)":/.exec(gateway ?? "")?.[1];
    assert.ok(sent, "could not find the secret header in the gateway's usage.ts");
    assert.match(route, new RegExp(`headers\\.get\\("${sent}"\\)`), `route does not read ${sent}`);
  });

  it("accepts every field the gateway reports", () => {
    // A field the schema strips never reaches the meter: dropping the cache
    // counts billed a cached call on `inputTokens` alone, which Bedrock reports
    // EXCLUSIVE of them.
    const accepted = new Set(routeSchemaKeys(route));
    const missing = gatewayBodyKeys(gateway ?? "").filter((k) => !accepted.has(k));
    assert.deepEqual(missing, [], `fields the gateway sends that the route ignores: ${missing.join(", ")}`);
  });

  it("answers the overCap flag the gateway enforces the spend cap with", () => {
    // The gateway's only view of the spend cap mid-TTL is `overCap` in this
    // reply; anything but a literal `true` reads as "under cap", so without it an
    // org that crosses its cap keeps being served for the rest of the token's hour.
    assert.match(gateway ?? "", /overCap/, "the gateway no longer reads overCap — re-check this test");
    assert.match(route, /overCap/);
  });

  it("still posts to /api/proxy-usage", () => {
    assert.match(gateway ?? "", /\/api\/proxy-usage/);
  });
});
