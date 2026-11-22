// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Email-match auto-join scope. A SAML account's confirmed email is whatever its
 * org's IdP asserted — Supabase marks it verified and does not check it against
 * the provider's domains — so an Admin's IdP asserting `invitee@victim.com` must
 * not pick up another org's pending invites or SCIM seats. These pin the rule
 * `acceptPendingInvites` and `reconcileScimMemberships` both filter by.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoJoinScope,
  resolveAutoJoinOrg,
} from "../src/features/account/controllers/auto-join-core.ts";

const PROVIDER = "6f9b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const OTHER_PROVIDER = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

const emailUser = { app_metadata: { provider: "email", providers: ["email"] }, identities: [{ provider: "email" }] };
const githubUser = { app_metadata: { provider: "github", providers: ["github"] }, identities: [{ provider: "github" }] };
const samlUser = {
  app_metadata: { provider: `sso:${PROVIDER}`, providers: [`sso:${PROVIDER}`] },
  identities: [{ provider: `sso:${PROVIDER}` }],
};

function owners(map: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    find: async (providerId: string) => {
      calls.push(providerId);
      return map[providerId] ?? null;
    },
  };
}

describe("autoJoinScope", () => {
  it("trusts email/password and OAuth accounts across orgs", () => {
    assert.deepEqual(autoJoinScope(emailUser), { kind: "any" });
    assert.deepEqual(autoJoinScope(githubUser), { kind: "any" });
  });

  it("pins a SAML account to the SSO provider it signed in through", () => {
    assert.deepEqual(autoJoinScope(samlUser), { kind: "sso-provider", providerId: PROVIDER });
  });

  it("narrows on an sso identity even when the metadata names another provider", () => {
    assert.deepEqual(
      autoJoinScope({ app_metadata: { provider: "email" }, identities: [{ provider: `sso:${PROVIDER}` }] }),
      { kind: "sso-provider", providerId: PROVIDER },
    );
  });

  it("matches nothing when the SSO provider is ambiguous or not a provider id", () => {
    assert.deepEqual(
      autoJoinScope({
        identities: [{ provider: `sso:${PROVIDER}` }, { provider: `sso:${OTHER_PROVIDER}` }],
      }),
      { kind: "none" },
    );
    assert.deepEqual(autoJoinScope({ app_metadata: { provider: "sso:saml" } }), { kind: "none" });
  });
});

describe("resolveAutoJoinOrg", () => {
  it("leaves a non-SSO account unfiltered without a provider lookup", async () => {
    const o = owners({});
    assert.deepEqual(await resolveAutoJoinOrg(emailUser, o.find), { orgId: null });
    assert.deepEqual(o.calls, []);
  });

  it("filters a SAML account to the org owning its provider", async () => {
    const o = owners({ [PROVIDER]: "org-idp" });
    assert.deepEqual(await resolveAutoJoinOrg(samlUser, o.find), { orgId: "org-idp" });
    assert.deepEqual(o.calls, [PROVIDER]);
  });

  it("auto-joins nothing for a SAML account whose provider no org owns", async () => {
    const o = owners({ [OTHER_PROVIDER]: "org-other" });
    assert.equal(await resolveAutoJoinOrg(samlUser, o.find), null);
  });

  it("auto-joins nothing for an SSO account with no resolvable provider", async () => {
    const o = owners({ [PROVIDER]: "org-idp" });
    assert.equal(await resolveAutoJoinOrg({ app_metadata: { provider: "sso:saml" } }, o.find), null);
    assert.deepEqual(o.calls, []);
  });
});
