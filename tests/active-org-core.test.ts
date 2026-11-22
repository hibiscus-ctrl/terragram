// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The active-org rules. Pinned: the cookie only ever selects among the caller's
 * own memberships — a stale or foreign id falls back to the oldest membership and
 * never names an org they don't belong to — the fallback order does not depend on
 * row order, and no memberships resolve to no org.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeOrgCookieOptions,
  canSwitchTo,
  parseActiveOrgCookie,
  resolveActiveOrgId,
} from "../src/features/account/controllers/active-org-core.ts";

const PERSONAL = "00000000-0000-4000-8000-00000000000a";
const TEAM = "00000000-0000-4000-8000-00000000000b";
const FOREIGN = "00000000-0000-4000-8000-00000000000f";

const MEMBERSHIPS = [
  { orgId: TEAM, createdAt: "2026-09-01T00:00:00.000Z" },
  { orgId: PERSONAL, createdAt: "2026-01-01T00:00:00.000Z" },
];

describe("resolveActiveOrgId", () => {
  it("uses the cookie's org when the caller belongs to it", () => {
    assert.equal(resolveActiveOrgId(MEMBERSHIPS, TEAM), TEAM);
    assert.equal(resolveActiveOrgId(MEMBERSHIPS, TEAM.toUpperCase()), TEAM);
  });

  it("falls back to the oldest membership with no cookie", () => {
    assert.equal(resolveActiveOrgId(MEMBERSHIPS, null), PERSONAL);
    assert.equal(resolveActiveOrgId(MEMBERSHIPS, undefined), PERSONAL);
    assert.equal(resolveActiveOrgId(MEMBERSHIPS, ""), PERSONAL);
  });

  it("never resolves to an org the caller is not a member of", () => {
    // A stale cookie (they left or were removed) and a hand-written one alike.
    assert.equal(resolveActiveOrgId(MEMBERSHIPS, FOREIGN), PERSONAL);
    assert.equal(resolveActiveOrgId([{ orgId: TEAM, createdAt: "2026-09-01T00:00:00Z" }], PERSONAL), TEAM);
  });

  it("ignores a value that is not an org id at all", () => {
    for (const junk of ["acme", `${TEAM};admin`, " ", "../../etc"]) {
      assert.equal(resolveActiveOrgId(MEMBERSHIPS, junk), PERSONAL, junk);
    }
  });

  it("resolves no org for a user with no memberships, cookie or not", () => {
    assert.equal(resolveActiveOrgId([], null), null);
    assert.equal(resolveActiveOrgId([], TEAM), null);
  });

  it("orders the fallback by membership age, then org id, whatever the row order", () => {
    assert.equal(resolveActiveOrgId([...MEMBERSHIPS].reverse(), null), PERSONAL);
    const sameInstant = "2026-05-05T00:00:00.000Z";
    const tied = [
      { orgId: TEAM, createdAt: sameInstant },
      { orgId: PERSONAL, createdAt: sameInstant },
    ];
    assert.equal(resolveActiveOrgId(tied, null), PERSONAL);
    assert.equal(resolveActiveOrgId([...tied].reverse(), null), PERSONAL);
  });
});

describe("canSwitchTo", () => {
  it("allows only an org the caller belongs to", () => {
    assert.equal(canSwitchTo(MEMBERSHIPS, TEAM), true);
    assert.equal(canSwitchTo(MEMBERSHIPS, FOREIGN), false);
    assert.equal(canSwitchTo(MEMBERSHIPS, "not-an-id"), false);
    assert.equal(canSwitchTo([], PERSONAL), false);
  });
});

describe("parseActiveOrgCookie", () => {
  it("keeps a uuid, normalised, and nothing else", () => {
    assert.equal(parseActiveOrgCookie(` ${TEAM.toUpperCase()} `), TEAM);
    assert.equal(parseActiveOrgCookie("org-1"), null);
    assert.equal(parseActiveOrgCookie(null), null);
  });
});

describe("activeOrgCookieOptions", () => {
  it("is httpOnly and SameSite=Lax, Secure when asked, across the whole site", () => {
    const options = activeOrgCookieOptions(true);
    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, true);
    assert.equal(options.sameSite, "lax");
    assert.equal(options.path, "/");
    assert.equal(activeOrgCookieOptions(false).secure, false);
  });
});
