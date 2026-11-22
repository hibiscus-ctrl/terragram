// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The readiness decision behind `/api/health/ready`. The property that matters for
 * deploy gating is that ONLY an unreachable database fails the probe: a
 * half-configured optional feature is reported, never a 503 — a restart loop
 * cannot fix a missing variable, and failing on it would take a deploy down over
 * something that is often a deliberate choice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkEnv } from "../src/config/env.ts";
import { readiness } from "../src/features/api/readiness.ts";

const now = new Date("2026-10-10T00:00:00.000Z");
const complete = checkEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  NEXT_PUBLIC_SITE_URL: "https://example.test",
});

describe("readiness", () => {
  it("is 200 ready when the database answers", () => {
    const { status, body } = readiness({ databaseOk: true, env: complete, now });
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.checks.database, true);
    assert.equal(body.time, now.toISOString());
  });

  it("is 503 unavailable when the database does not", () => {
    const { status, body } = readiness({ databaseOk: false, env: complete, now });
    assert.equal(status, 503);
    assert.equal(body.status, "unavailable");
  });

  it("reports a half-configured feature without failing the probe", () => {
    const env = checkEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      SUPABASE_SECRET_KEY: "sb_secret_x",
      NEXT_PUBLIC_SITE_URL: "https://example.test",
      STRIPE_SECRET_KEY: "sk_test_x",
    });
    const { status, body } = readiness({ databaseOk: true, env, now });
    assert.equal(status, 200);
    assert.equal(body.checks.env.ok, false);
    assert.deepEqual(body.checks.env.incomplete, { billing: ["STRIPE_WEBHOOK_SECRET"] });
  });

  it("reports a too-short jobs secret by name, without failing the probe or echoing it", () => {
    const secret = "short-secret";
    const env = checkEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
      SUPABASE_SECRET_KEY: "sb_secret_x",
      NEXT_PUBLIC_SITE_URL: "https://example.test",
      JOBS_DRAIN_SECRET: secret,
    });
    const { status, body } = readiness({ databaseOk: true, env, now });
    assert.equal(status, 200);
    assert.deepEqual(body.checks.env.weak, ["JOBS_DRAIN_SECRET (min 16)"]);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  });

  it("carries variable names only, never values", () => {
    const secret = "sk_test_do_not_echo_me";
    const env = checkEnv({ STRIPE_SECRET_KEY: secret });
    const { body } = readiness({ databaseOk: true, env, now });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  });
});
