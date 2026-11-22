// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scheduler-facing job routes over HTTP: `x-jobs-secret`, compared in
 * constant time against `JOBS_DRAIN_SECRET` (a placeholder pinned by .env.test).
 *
 * Refusals only. The suite never presents the CORRECT secret: past the gate,
 * `/api/jobs/flush-usage` reports every org's unbilled managed usage to Stripe,
 * against the shared project. The decision behind these answers is unit-tested
 * in `tests/jobs-secret.test.ts`; the unconfigured server's answer is in
 * `tests/api-unconfigured/`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { api, CONFIGURED, uniqueIp } from "./helpers/client.ts";
import { assertApiError, assertRateLimited } from "./helpers/shape.ts";

const READY = CONFIGURED && Boolean(process.env.JOBS_DRAIN_SECRET);

const ROUTES = ["/api/jobs/flush-usage", "/api/jobs/reconcile-managed"];

describe("x-jobs-secret routes", { skip: !READY }, () => {
  it("JOB-N1: a missing secret header is 401", async () => {
    for (const path of ROUTES) {
      assertApiError(await api().post(path).set("x-forwarded-for", uniqueIp()), 401, "unauthorized");
    }
  });

  it("JOB-N2: a wrong secret is 401, with the same body", async () => {
    const secret = process.env.JOBS_DRAIN_SECRET ?? "";
    for (const path of ROUTES) {
      for (const wrong of ["not-the-secret-0000", `${secret}x`, secret.slice(0, -1)]) {
        const res = await api().post(path).set("x-jobs-secret", wrong).set("x-forwarded-for", uniqueIp());
        assertApiError(res, 401, "unauthorized");
      }
    }
  });

  it("JOB-N3: the refusal carries no configuration detail", async () => {
    // An unconfigured server answers this same 401 (see tests/api-unconfigured/),
    // so the body must not start naming things — an env var, a route-specific code.
    for (const path of ROUTES) {
      const res = await api().post(path).set("x-jobs-secret", "not-the-secret-0000").set("x-forwarded-for", uniqueIp());
      const body = JSON.stringify(res.body);
      assert.doesNotMatch(body, /JOBS_DRAIN_SECRET|unconfigured|not set|env/i, `${path} leaked: ${body}`);
    }
  });

  it("JOB-B1: the 61st guess from one IP inside a minute is 429, before the compare", async () => {
    const ip = uniqueIp();
    let last: Awaited<ReturnType<ReturnType<typeof api>["post"]>> | undefined;
    for (let i = 0; i < 61; i++) {
      last = await api().post("/api/jobs/flush-usage").set("x-jobs-secret", `guess-${i}-000000000000`).set("x-forwarded-for", ip);
      if (i < 60) assert.equal(last.status, 401, `call ${i}`);
    }
    assert.ok(last);
    assertRateLimited(last);
  });
});
