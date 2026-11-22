// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where an OAuth/SSO sign-in or an email-confirmed sign-up lands. Pinned: only a
 * same-site path is ever stored or followed — vetted when the cookie is set and
 * again when the callback or /auth/confirm reads it — the cookie is httpOnly,
 * short-lived and scoped to /auth, a link's own vetted `next` wins over it, a
 * missing or tampered value lands in the workspace, and links between sign-in
 * and sign-up keep the place to return to.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTH_NEXT_COOKIE,
  authNextCookie,
  DEFAULT_LANDING,
  landingAfterSignIn,
  withNext,
} from "../src/features/account/controllers/auth-next-core.ts";

const OFF_SITE = ["https://evil.test/", "//evil.test", "/\\evil.test", "/\t/evil.test", "javascript:alert(1)"];

describe("authNextCookie", () => {
  it("stores a same-site path, normalised", () => {
    const cookie = authNextCookie("/invite/abc_DEF-123", true);
    assert.ok(cookie);
    assert.equal(cookie.name, AUTH_NEXT_COOKIE);
    assert.equal(cookie.value, "/invite/abc_DEF-123");
  });

  it("is httpOnly, SameSite=Lax, short-lived and sent only to the /auth routes", () => {
    const cookie = authNextCookie("/invite/abc", true);
    assert.ok(cookie);
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.secure, true);
    assert.equal(cookie.options.sameSite, "lax");
    // /auth covers both consumers: /auth/callback (OAuth, SSO) and /auth/confirm (email).
    assert.equal(cookie.options.path, "/auth");
    assert.ok(cookie.options.maxAge > 0 && cookie.options.maxAge <= 30 * 60);
    assert.equal(authNextCookie("/invite/abc", false)?.options.secure, false);
  });

  it("stores nothing for an off-site, empty or non-string value", () => {
    for (const raw of [...OFF_SITE, "", "workspace", null, undefined, 42, { toString: () => "/x" }]) {
      assert.equal(authNextCookie(raw, true), null, String(raw));
    }
  });
});

describe("landingAfterSignIn", () => {
  it("follows a stored same-site path", () => {
    assert.equal(landingAfterSignIn("/invite/abc"), "/invite/abc");
  });

  it("lands in the workspace with no cookie", () => {
    assert.equal(landingAfterSignIn(undefined), DEFAULT_LANDING);
    assert.equal(landingAfterSignIn(null), DEFAULT_LANDING);
    assert.equal(landingAfterSignIn(""), DEFAULT_LANDING);
    assert.equal(DEFAULT_LANDING, "/workspace");
  });

  it("re-vets the value, so a cookie written by hand cannot open-redirect", () => {
    for (const raw of OFF_SITE) assert.equal(landingAfterSignIn(raw), DEFAULT_LANDING, raw);
  });

  it("prefers a link's own vetted next over the cookie, and falls back past a hostile one", () => {
    assert.equal(landingAfterSignIn("/invite/cookie", "/invite/link"), "/invite/link");
    assert.equal(landingAfterSignIn("/invite/cookie", null), "/invite/cookie");
    for (const raw of OFF_SITE) {
      assert.equal(landingAfterSignIn("/invite/cookie", raw), "/invite/cookie", raw);
      assert.equal(landingAfterSignIn(raw, raw), DEFAULT_LANDING, raw);
    }
  });
});

describe("withNext", () => {
  it("keeps a vetted next on the link, encoded", () => {
    assert.equal(withNext("/signup", "/invite/abc"), "/signup?next=%2Finvite%2Fabc");
    assert.equal(withNext("/login", "/invite/a?b=c"), "/login?next=%2Finvite%2Fa%3Fb%3Dc");
  });

  it("drops an off-site, empty or default next", () => {
    for (const raw of [...OFF_SITE, "", null, undefined, DEFAULT_LANDING]) {
      assert.equal(withNext("/login", raw), "/login", String(raw));
    }
  });
});
