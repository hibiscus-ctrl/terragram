// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCspHeaderName,
  buildCspPolicy,
  buildReportingEndpointsHeader,
  CSP_REPORT_ENDPOINT,
  CSP_REPORT_PATH,
  generateNonce,
} from "../src/utils/csp.ts";

function directive(policy: string, name: string): string {
  const found = policy.split("; ").find((d) => d.startsWith(`${name} `));
  return found ?? "";
}

describe("buildCspPolicy", () => {
  it("carries the request's own nonce and strict-dynamic in script-src", () => {
    const policy = buildCspPolicy("abc123", false);
    const scripts = directive(policy, "script-src");
    assert.ok(scripts.includes("'nonce-abc123'"));
    assert.ok(scripts.includes("'strict-dynamic'"));
    assert.ok(!scripts.includes("'unsafe-inline'"), "a nonce plus unsafe-inline is not a policy");
  });

  it("allows eval only in development, where the Next overlay needs it", () => {
    assert.ok(buildCspPolicy("n", true).includes("'unsafe-eval'"));
    assert.ok(!buildCspPolicy("n", false).includes("'unsafe-eval'"));
  });

  it("keeps style-src on unsafe-inline, because style ATTRIBUTES cannot carry a nonce", () => {
    const styles = directive(buildCspPolicy("n", false), "style-src");
    assert.ok(styles.includes("'unsafe-inline'"));
    assert.ok(!styles.includes("nonce"), "a nonce here would silently disable unsafe-inline");
  });

  it("names both reporting directives, since no browser honours both", () => {
    const policy = buildCspPolicy("n", false);
    assert.ok(policy.includes(`report-uri ${CSP_REPORT_PATH}`), "Firefox and Safari need report-uri");
    assert.ok(policy.includes(`report-to ${CSP_REPORT_ENDPOINT}`), "Chromium needs report-to");
    assert.equal(buildReportingEndpointsHeader(), `${CSP_REPORT_ENDPOINT}="${CSP_REPORT_PATH}"`);
  });

  it("restates the directives next.config.js enforces, so promoting it needs no second edit", () => {
    const policy = buildCspPolicy("n", false);
    for (const d of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"]) {
      assert.ok(policy.includes(d), `missing ${d}`);
    }
  });

  it("allowlists the Supabase origin it is given, and nothing wider", () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co/rest/v1";
    try {
      const connect = directive(buildCspPolicy("n", false), "connect-src");
      assert.ok(connect.includes("https://example.supabase.co"));
      assert.ok(!connect.includes("/rest/v1"), "the origin, not the path the env var carries");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
    }
  });

  it("survives an unparseable Supabase URL rather than emitting a broken directive", () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not a url";
    try {
      assert.equal(directive(buildCspPolicy("n", false), "connect-src").includes("not a url"), false);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
    }
  });

  it("upgrades insecure requests only in production, where TLS terminates in front", () => {
    assert.ok(buildCspPolicy("n", false).endsWith("upgrade-insecure-requests"));
    assert.ok(!buildCspPolicy("n", true).includes("upgrade-insecure-requests"));
  });
});

describe("rollout switch", () => {
  it("ships report-only, so the policy cannot break a page before the soak", () => {
    assert.equal(buildCspHeaderName(), "Content-Security-Policy-Report-Only");
  });
});

describe("generateNonce", () => {
  it("is fresh per call — a reused nonce is equivalent to unsafe-inline", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    assert.equal(nonces.size, 50);
  });
});
