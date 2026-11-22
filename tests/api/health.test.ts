// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The liveness probe — the URL `start-server-and-test` (and Railway) gate on.
 *
 * `/api/health/ready` (a readiness probe reporting configuration by name) is
 * being added separately; when it lands, its shape belongs here and the
 * unconfigured suite's GUARD-1 can ask it directly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { api, CONFIGURED } from "./helpers/client.ts";
import { assertExactKeys } from "./helpers/shape.ts";

describe("GET /api/health", { skip: !CONFIGURED }, () => {
  it("H-P1: liveness is 200 with the static shape", async () => {
    const res = await api().get("/api/health");
    assert.equal(res.status, 200);
    assertExactKeys(res.body, ["service", "status", "time"]);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.service, "terragram-ui");
    assert.ok(Number.isFinite(Date.parse(String(res.body.time))), "time is ISO");
  });

  it("H-N1: is never cached — two calls carry different times", async () => {
    const a = await api().get("/api/health");
    await new Promise((r) => setTimeout(r, 5));
    const b = await api().get("/api/health");
    assert.notEqual(a.body.time, b.body.time, "the probe answered from a cache");
  });

  it("H-N2: POST to a GET-only route is 405", async () => {
    const res = await api().post("/api/health").send({});
    assert.equal(res.status, 405);
  });

  it("H-N3: an API response carries no CSP — it is never a browser document", async () => {
    const res = await api().get("/api/health");
    assert.equal(res.headers["content-security-policy-report-only"], undefined);
    assert.equal(res.headers["reporting-endpoints"], undefined);
  });
});
