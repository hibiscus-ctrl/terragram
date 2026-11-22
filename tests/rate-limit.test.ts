// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the rate limiter + the trusted-IP picker. Pure-ish — run with
 * `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { pickTrustedIp, rateLimit } from "../src/libs/rate-limit.ts";

const STORE_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(STORE_ENV.map((k) => [k, process.env[k]]));
  for (const k of STORE_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of STORE_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let n = 0;
const uniqueKey = () => `rl-test:${n++}`;

describe("rateLimit — in-memory fixed window (no shared store configured)", () => {
  it("allows up to the limit then blocks with a positive retryAfterMs", async () => {
    const k = uniqueKey();
    const opts = { limit: 2, windowMs: 60_000 };
    assert.equal((await rateLimit(k, opts)).ok, true);
    assert.equal((await rateLimit(k, opts)).ok, true);
    const blocked = await rateLimit(k, opts);
    assert.equal(blocked.ok, false);
    assert.ok(!blocked.ok && blocked.retryAfterMs > 0);
  });

  it("applies the in-process counter to a failClosed caller too — there is no store to fail", async () => {
    const k = uniqueKey();
    const opts = { limit: 1, windowMs: 60_000, failClosed: true };
    assert.equal((await rateLimit(k, opts)).ok, true);
    assert.equal((await rateLimit(k, opts)).ok, false);
  });
});

/**
 * Under plain Node the service-role client cannot even be imported (`server-only`
 * throws outside the react-server condition), which is exactly the "store
 * unavailable" condition the fallback exists for — so setting the env here drives
 * the real branch with no mock.
 */
describe("rateLimit — shared store configured but unavailable", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    process.env.SUPABASE_SECRET_KEY = "not-a-real-key";
  });

  it("DENIES a failClosed caller at once, with the full window as retry-after", async () => {
    const result = await rateLimit(uniqueKey(), { limit: 100, windowMs: 45_000, failClosed: true });
    assert.deepEqual(result, { ok: false, retryAfterMs: 45_000 });
  });

  it("degrades an ordinary caller to the in-process counter — bounded, not refused", async () => {
    const k = uniqueKey();
    const opts = { limit: 2, windowMs: 60_000 };
    assert.equal((await rateLimit(k, opts)).ok, true);
    assert.equal((await rateLimit(k, opts)).ok, true);
    assert.equal((await rateLimit(k, opts)).ok, false);
  });

  it("recognises the legacy service-role key name as configuring the store", async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy-key";
    const result = await rateLimit(uniqueKey(), { limit: 100, windowMs: 1_000, failClosed: true });
    assert.equal(result.ok, false);
  });
});

describe("pickTrustedIp — trusted-hop selection", () => {
  it("ignores a spoofed leftmost entry and takes the proxy-added rightmost hop", () => {
    assert.equal(pickTrustedIp("1.2.3.4, 9.9.9.9", null, 1), "9.9.9.9");
  });

  it("returns the only entry when the client sent no forwarded header", () => {
    assert.equal(pickTrustedIp("9.9.9.9", null, 1), "9.9.9.9");
  });

  it("honours a higher trusted-hop count (two proxies in front)", () => {
    // [spoof, realclient, edge] with 2 trusted hops → realclient
    assert.equal(pickTrustedIp("1.2.3.4, 5.6.7.8, 9.9.9.9", null, 2), "5.6.7.8");
  });

  it("falls back to x-real-ip then 'unknown'", () => {
    assert.equal(pickTrustedIp(null, "7.7.7.7", 1), "7.7.7.7");
    assert.equal(pickTrustedIp(null, null, 1), "unknown");
  });
});
