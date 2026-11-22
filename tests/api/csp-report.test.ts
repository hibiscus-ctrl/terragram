// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTTP contract for the CSP violation collector.
 *
 * The endpoint answers 204 to EVERYTHING (a browser never reads the reply, so any
 * other status is only information for a prober) and cannot be turned into a
 * memory or log amplifier by a body nobody authenticated. It is deliberately
 * unauthenticated; tests/route-auth-posture.test.ts carries the written reason.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { api, CONFIGURED, uniqueIp } from "./helpers/client.ts";

const PATH = "/api/csp-report";

const legacyReport = (over: Record<string, unknown> = {}) => ({
  "csp-report": {
    "document-uri": "http://localhost:3100/shared/secret-share-token?x=1",
    "violated-directive": "script-src 'self'",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://cdn.example.com/widget.js",
    disposition: "report",
    ...over,
  },
});

const post = (contentType: string, body: string) =>
  api().post(PATH).set("content-type", contentType).set("x-forwarded-for", uniqueIp()).send(body);

describe("POST /api/csp-report", { skip: !CONFIGURED }, () => {
  it("CSP-P1: accepts a legacy report-uri body with 204 and no body", async () => {
    const res = await post("application/csp-report", JSON.stringify(legacyReport()));
    assert.equal(res.status, 204);
    assert.equal(res.text, "");
  });

  it("CSP-P2: accepts a Reporting API batch (application/reports+json)", async () => {
    const res = await post(
      "application/reports+json",
      JSON.stringify([
        {
          type: "csp-violation",
          body: {
            documentURL: "http://localhost:3100/workspace",
            effectiveDirective: "script-src-elem",
            blockedURL: "https://cdn.example.com/widget.js",
          },
        },
      ]),
    );
    assert.equal(res.status, 204);
  });

  it("CSP-N1: malformed JSON is 204, not 400 — there is nobody to tell", async () => {
    assert.equal((await post("application/csp-report", "{not json")).status, 204);
  });

  it("CSP-N2: a well-formed body that is not a CSP report is 204", async () => {
    for (const payload of ["{}", "[]", "null", '{"csp-report":{}}', '[{"type":"deprecation"}]']) {
      assert.equal((await post("application/json", payload)).status, 204, `payload ${payload}`);
    }
  });

  it("CSP-N3: an oversized body is dropped, still with 204", async () => {
    const huge = JSON.stringify(legacyReport({ "script-sample": "x".repeat(200_000) }));
    assert.equal((await post("application/csp-report", huge)).status, 204);
  });

  it("CSP-N4: past the per-IP limit it still answers 204 — the limit is silent", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 32; i++) {
      const res = await api()
        .post(PATH)
        .set("content-type", "application/csp-report")
        .set("x-forwarded-for", ip)
        .send(JSON.stringify(legacyReport()));
      assert.equal(res.status, 204, `request ${i + 1}`);
    }
  });

  it("CSP-N5: GET is 405 — the framework's method gate still applies", async () => {
    assert.equal((await api().get(PATH)).status, 405);
  });
});

describe("CSP reporting is wired end-to-end", { skip: !CONFIGURED }, () => {
  it("CSP-P3: a page response carries a policy that names this endpoint", async () => {
    const res = await api().get("/login");
    const policy = String(
      res.headers["content-security-policy-report-only"] ?? res.headers["content-security-policy"] ?? "",
    );
    assert.ok(policy, "no CSP on a page response");
    assert.ok(policy.includes(`report-uri ${PATH}`), `report-uri missing from: ${policy}`);
    assert.ok(policy.includes("report-to "), `report-to missing from: ${policy}`);
  });

  it("CSP-P4: and declares the endpoint group report-to resolves against", async () => {
    const res = await api().get("/login");
    assert.match(String(res.headers["reporting-endpoints"] ?? ""), new RegExp(`="${PATH}"`));
  });
});
