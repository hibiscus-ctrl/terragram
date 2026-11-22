// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The redirect-contract routes for a SIGNED-OUT caller: /auth/confirm,
 * /auth/callback, /manage-subscription, and the proxy's guard on every protected
 * prefix. Their failure contract is "redirect, never an error status", and no
 * `next=` value or forwarded header may ever point the Location off-site. The
 * signed-in halves are in seeded.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { api, BASE_ORIGIN, CONFIGURED, SITE_ORIGIN } from "./helpers/client.ts";
import { assertSameOriginRedirect } from "./helpers/shape.ts";

describe("GET /auth/confirm", { skip: !CONFIGURED }, () => {
  it("CONF-N1: missing or bogus token_hash/type always lands on /login", async () => {
    for (const qs of ["", "?token_hash=bogus", "?type=email", "?token_hash=bogus&type=email"]) {
      const res = await api().get(`/auth/confirm${qs}`).redirects(0);
      const to = assertSameOriginRedirect(res, SITE_ORIGIN, qs || "(no params)");
      assert.equal(to.pathname, "/login", qs);
    }
  });

  it("CONF-N2: hostile next= values can never steer the redirect off-site", async () => {
    for (const next of [
      "//evil.example",
      "https://evil.example",
      "%2F%2Fevil.example",
      "\\\\evil.example",
      "/\\evil.example",
      "https:%2F%2Fevil.example",
    ]) {
      const res = await api()
        .get(`/auth/confirm?token_hash=bogus&type=magiclink&next=${next}`)
        .set("x-forwarded-host", "evil.example")
        .redirects(0);
      assertSameOriginRedirect(res, SITE_ORIGIN, `next=${next}`);
    }
  });
});

describe("GET /auth/callback", { skip: !CONFIGURED }, () => {
  it("CB-N1: no code redirects to the site root", async () => {
    const res = await api().get("/auth/callback").redirects(0);
    const to = assertSameOriginRedirect(res, SITE_ORIGIN, "no code");
    assert.equal(to.pathname, "/");
  });

  it("CB-N2: an invalid or replayed code lands on /login, never an error page", async () => {
    const res = await api().get("/auth/callback?code=00000000-dead-beef-0000-000000000000").redirects(0);
    const to = assertSameOriginRedirect(res, SITE_ORIGIN, "bad code");
    assert.equal(to.pathname, "/login");
  });
});

describe("protected prefixes, signed out", { skip: !CONFIGURED }, () => {
  it("ROUTE-N1: every protected prefix redirects to /login and drops the query", async () => {
    for (const path of [
      "/workspace",
      "/workspace/canvas?mode=chat-diagram",
      "/workspace/settings",
      "/billing",
      "/settings",
      "/account",
      "/manage-subscription",
    ]) {
      const res = await api().get(path).redirects(0);
      const to = assertSameOriginRedirect(res, BASE_ORIGIN, path);
      assert.equal(to.pathname, "/login", path);
      assert.equal(to.search, "", `${path} carried its query onto /login`);
    }
  });

  it("ROUTE-N2: an unknown share token is the plain 404, not a redirect or a 500", async () => {
    const res = await api().get("/shared/not-a-real-token").redirects(0);
    assert.equal(res.status, 404);
  });

  it("ROUTE-P1: the public pages render signed out", async () => {
    for (const path of ["/", "/login", "/signup", "/pricing", "/verify"]) {
      const res = await api().get(path).redirects(0);
      assert.equal(res.status, 200, path);
    }
  });
});
