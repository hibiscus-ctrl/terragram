// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The invite email template: what the invitee reads, that the link is the only
 * place the token appears, and that nothing an org or a user named can inject
 * markup into the HTML part.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InviteEmail } from "../src/features/emails/invite.ts";

const LINK = "https://terragram.test/invite/raw-token-123";

describe("InviteEmail", () => {
  it("names the org on Terragram in the subject", () => {
    const r = InviteEmail({ inviteUrl: LINK, orgName: "Acme", role: "Maintainer", invitedBy: "ada@acme.test" });
    assert.equal(r.subject, "You're invited to Acme on Terragram");
  });

  it("carries the org, role, inviter and link in both parts", () => {
    const r = InviteEmail({ inviteUrl: LINK, orgName: "Acme", role: "Billing Manager", invitedBy: "ada@acme.test" });
    for (const part of [r.html, r.text]) {
      assert.ok(part.includes("Acme"));
      assert.ok(part.includes("Billing Manager"));
      assert.ok(part.includes("ada@acme.test invited you"));
      assert.ok(part.includes(LINK));
      assert.ok(part.includes("expires in 14 days"));
    }
    assert.ok(r.html.includes(`href="${LINK}"`));
  });

  it("has a plain-text part with no markup", () => {
    const r = InviteEmail({ inviteUrl: LINK, orgName: "Acme", role: "Admin", invitedBy: null });
    assert.doesNotMatch(r.text, /<[a-z/!]/i);
    assert.ok(r.text.startsWith("You have been invited to the Acme organisation on Terragram"));
    assert.ok(r.text.includes(`Accept invitation: ${LINK}`));
  });

  it("says who invited them only when it knows", () => {
    const r = InviteEmail({ inviteUrl: LINK, orgName: "Acme", role: "Admin", invitedBy: null });
    assert.ok(r.html.includes("You have been invited"));
    assert.ok(!r.html.includes("null"));
  });

  it("puts the token in the link and nowhere else", () => {
    const r = InviteEmail({ inviteUrl: LINK, orgName: "Acme", role: "Admin", invitedBy: "ada@acme.test" });
    assert.ok(!r.subject.includes("raw-token-123"));
    // The button and the paste-this-link fallback, and only those.
    assert.equal(r.html.split("raw-token-123").length - 1, 3, "two hrefs and the visible fallback link");
    assert.equal(r.text.split("raw-token-123").length - 1, 1);
  });

  it("escapes the org, role and inviter so the HTML cannot be injected", () => {
    const r = InviteEmail({
      inviteUrl: `${LINK}"><script>x</script>`,
      orgName: `<script>alert(1)</script>`,
      role: `adm<b>in`,
      invitedBy: `"><img src=x onerror=alert(1)>`,
    });
    assert.ok(!r.html.includes("<script>"));
    assert.ok(!r.html.includes("<img"));
    assert.ok(!r.html.includes("<b>"));
    assert.ok(r.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(r.html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(r.html.includes("adm&lt;b&gt;in"));
    // The hidden preheader is built from the same values.
    assert.ok(!/<div[^>]*>[^<]*<script/.test(r.html));
  });
});
