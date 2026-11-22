// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The cases whose PREMISE is that a required key is absent: every route that
 * depends on a secret must fail CLOSED without it — refuse, never verify against
 * an empty string, never fall through to the work.
 *
 * Runs against a SECOND server (port 3101, `.env.test.unconfigured`) with the
 * keys blanked. Sequential with the main suite, never concurrent: Next allows one
 * dev server per project.
 *
 * GUARD-1 runs first and asserts the server really is unconfigured. A suite whose
 * premise lives in an env file layered over another file, in a process this one
 * does not own, has to check that premise — otherwise an env file that silently
 * stopped taking effect would look like a green suite. It asks the git OAuth
 * callback, whose answer names configuration ("not-configured"), and
 * `/api/health/ready`, whose per-feature report is the one place configuration
 * presence is published — never inferring it from an error body. That matters
 * most for the job routes: an unset and a wrong `JOBS_DRAIN_SECRET` are meant to
 * be indistinguishable to a caller, so no assertion on their RESPONSE could tell
 * this server from the configured one.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { api, BASE_URL, CONFIGURED, SITE_ORIGIN } from "./helpers/client.ts";

/** A Stripe signature made with SOME secret — the server has none to check it against. */
function signed(raw: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", "whsec_any_secret").update(`${t}.${raw}`).digest("hex")}`;
}

/** A structurally valid `tmpx_` token signed with a secret this server does not hold. */
function token(secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ org: randomUUID(), model: null, scope: "model-proxy", exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return `tmpx_${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

describe("deliberately unconfigured server", { skip: !CONFIGURED, concurrency: false }, () => {
  it("GUARD-1: this server really is missing the keys the suite assumes", async () => {
    for (const provider of ["github", "gitlab"]) {
      const res = await api().get(`/api/git/${provider}/callback?code=x&state=${provider}.x`).redirects(0);
      const location = new URL(String(res.headers.location ?? ""), SITE_ORIGIN);
      assert.equal(
        location.searchParams.get("git_error"),
        "not-configured",
        `${BASE_URL} reports ${provider} OAuth as configured (redirected to ${location}) — .env.test.unconfigured did not take effect, so every assertion below is meaningless. Check that env-cmd is layering it over .env.local.`,
      );
    }

    const ready = await api().get("/api/health/ready");
    assert.ok([200, 503].includes(ready.status), `readiness status ${ready.status}`);
    assert.equal(
      ready.body.checks.env.features.jobsDrain,
      "off",
      `${BASE_URL} reports JOBS_DRAIN_SECRET as ${ready.body.checks.env.features.jobsDrain} — .env.test.unconfigured did not take effect.`,
    );
  });

  it("JOB-U1: with no jobs secret, every caller gets the 401 a wrong secret gets — never a 501", async () => {
    // Nothing to authenticate against, so every caller IS unauthenticated. A
    // correct-LOOKING secret is refused too: an empty configured value must never
    // be matched by an empty or any other header.
    for (const path of ["/api/jobs/flush-usage", "/api/jobs/reconcile-managed"]) {
      for (const header of [undefined, "", "x".repeat(32)]) {
        let req = api().post(path);
        if (header !== undefined) req = req.set("x-jobs-secret", header);
        const res = await req.send({});
        assert.equal(res.status, 401, `${path} header=${JSON.stringify(header)} → ${res.status} ${JSON.stringify(res.body)}`);
        assert.deepEqual(res.body, { error: "unauthorized" }, `${path}: the refusal must name no configuration`);
      }
    }
  });

  it("STRIPE-U1: a signed webhook is refused as unconfigured, not verified against an empty secret", async () => {
    const raw = JSON.stringify({ id: "evt_unconfigured", object: "event", type: "invoice.created", data: { object: {} } });
    const res = await api()
      .post("/api/webhooks")
      .set("content-type", "application/json")
      .set("stripe-signature", signed(raw))
      .send(raw);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "Missing Stripe signature or webhook secret");
  });

  it("PU-U1: the usage callback refuses every caller when no callback secret exists", async () => {
    // An empty configured secret must not be matched by an empty header — the
    // classic fail-open of `provided === secret`.
    for (const header of [undefined, "", "x".repeat(32)]) {
      let req = api().post("/api/proxy-usage");
      if (header !== undefined) req = req.set("x-infraweaver-proxy-secret", header);
      const res = await req.send({ token: token("anything"), inputTokens: 1, outputTokens: 1 });
      assert.equal(res.status, 401, `header=${JSON.stringify(header)} → ${res.status}`);
      assert.deepEqual(res.body, { error: "invalid_proxy_secret" });
    }
  });

  it("GIT-U1: neither Git provider starts an exchange", async () => {
    for (const provider of ["github", "gitlab"]) {
      const res = await api().get(`/api/git/${provider}/callback?code=real-looking&state=${provider}.s`).redirects(0);
      const to = new URL(String(res.headers.location ?? ""), SITE_ORIGIN);
      assert.equal(to.origin, SITE_ORIGIN, "redirect left the site");
      assert.equal(to.pathname, "/workspace/settings");
      assert.equal(to.searchParams.get("git_error"), "not-configured");
    }
  });

  it("WS-U1: the workspace model routes still refuse a signed-out caller first", async () => {
    for (const path of ["/api/workspace/translate", "/api/workspace/read-diagram"]) {
      const res = await api().post(path).send({ prompt: "x" });
      assert.equal(res.status, 401, path);
    }
  });

  it("HEALTH-U1: liveness does not depend on any of the blanked keys", async () => {
    const res = await api().get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });
});
