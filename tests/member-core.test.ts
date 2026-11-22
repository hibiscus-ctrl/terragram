// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The member-management decisions behind injected collaborators. Pinned: who may
 * invite and which roles the org's plan lets them hand out, the last-Admin and
 * own-membership refusals, that every change is audited BEFORE it is made and not
 * made when its audit row can't be written, that a change which fails after
 * its row was written leaves a `member.change_failed` row beside it, and that the
 * invite email can never undo or fail the invite it announces.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OrgMembership } from "../src/features/account/controllers/get-or-create-org.ts";
import type { OrgRole } from "../src/features/account/controllers/permissions.ts";
import {
  AUDITOR_PLAN_ERROR,
  assignableRoles,
  leaveError,
  type MemberActionDeps,
  makeMemberActions,
  removalError,
  roleChangeError,
  roleGrantError,
} from "../src/features/app/member-core.ts";
import type { AuditEntry } from "../src/features/platform/audit-events.ts";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const THIRD = "00000000-0000-4000-8000-000000000003";
const INVITE = "00000000-0000-4000-8000-0000000000aa";

const FREE_ORG = { id: "org-1", github_login: "acme", crosswalk_tier: null };
const TEAM_ORG = { id: "org-1", github_login: "acme", crosswalk_tier: "team" };

function setup(
  over: Partial<MemberActionDeps> & {
    role?: OrgRole;
    org?: Record<string, unknown>;
    members?: Record<string, OrgRole>;
    emails?: Record<string, string>;
  } = {},
) {
  const calls: string[] = [];
  const audits: AuditEntry[] = [];
  const members = over.members ?? { [ME]: over.role ?? "admin", [OTHER]: "maintainer" };
  const membership = {
    org: over.org ?? FREE_ORG,
    role: over.role ?? "admin",
    userId: ME,
  } as unknown as OrgMembership;
  const deps: MemberActionDeps = {
    guard: async (opts) => {
      calls.push("guard");
      if (opts.require && !opts.require(membership.role)) {
        return { ok: false, reason: "forbidden", error: opts.permissionError };
      }
      return { ok: true, membership };
    },
    rateLimit: async (name) => {
      calls.push(`rateLimit:${name}`);
      return { ok: true };
    },
    getCurrentMembership: async () => membership,
    currentUserEmail: async () => "me@acme.test",
    listMembershipRows: async () => Object.entries(members).map(([user_id, role]) => ({ user_id, role })),
    getAuthUserSummaries: async (ids) =>
      new Map(ids.map((id) => [id, { email: over.emails?.[id] ?? `${id}@acme.test` }])),
    generateInviteToken: () => ({ token: "tok", hash: "hash", expiresAt: "2026-10-24T00:00:00.000Z" }),
    inviteUrlFor: (token) => `https://terragram.test/invite/${token}`,
    newId: () => INVITE,
    getPendingInvite: async () => ({ email: "new@acme.test" }),
    deletePendingInviteByEmail: async () => {
      calls.push("deletePendingInviteByEmail");
    },
    insertInvite: async (row) => {
      calls.push(`insertInvite:${row.role}`);
      return true;
    },
    sendInviteEmail: async (params) => {
      calls.push(`sendInviteEmail:${params.to}`);
      return true;
    },
    deletePendingInvite: async () => {
      calls.push("deletePendingInvite");
      return true;
    },
    getMembershipRole: async (_org, userId) => members[userId] ?? null,
    updateMembershipRole: async (_org, userId, role) => {
      calls.push(`updateMembershipRole:${userId}:${role}`);
      return "ok";
    },
    deleteMembership: async (_org, userId) => {
      calls.push(`deleteMembership:${userId}`);
      return "ok";
    },
    acceptInviteByToken: async () => ({ status: "joined", orgLabel: "acme", orgId: "org-2" }),
    setActiveOrg: async (orgId) => {
      calls.push(`setActiveOrg:${orgId}`);
    },
    recordAudit: async (entry) => {
      calls.push(`audit:${entry.action}`);
      audits.push(entry);
      return true;
    },
    syncSeats: async (orgId, trigger) => {
      calls.push(`syncSeats:${orgId}:${trigger}`);
    },
    revalidate: (path) => {
      calls.push(`revalidate:${path}`);
    },
    ...over,
  };
  return { actions: makeMemberActions(deps), calls, audits };
}

const mutations = (calls: string[]) =>
  calls.filter((c) => /^(insertInvite|deletePendingInvite(?!ByEmail)|updateMembershipRole|deleteMembership)/.test(c));

describe("the rules", () => {
  it("lets an Admin hand out every role, the Auditor only on a plan that includes it", () => {
    assert.deepEqual(assignableRoles(false), ["admin", "maintainer", "billing_manager"]);
    assert.deepEqual(assignableRoles(true), ["admin", "maintainer", "auditor", "billing_manager"]);
    assert.equal(roleGrantError("auditor", false), AUDITOR_PLAN_ERROR);
    assert.equal(roleGrantError("auditor", true), null);
    assert.equal(roleGrantError("owner", true), "Unknown role.");
  });

  it("never demotes or removes the last Admin", () => {
    const base = { actorId: ME, targetId: OTHER, targetRole: "admin" as const };
    assert.match(roleChangeError({ ...base, nextRole: "maintainer", adminCount: 1 }) ?? "", /last Admin/);
    assert.equal(roleChangeError({ ...base, nextRole: "maintainer", adminCount: 2 }), null);
    assert.match(removalError({ ...base, adminCount: 1 }) ?? "", /last Admin/);
    assert.equal(removalError({ ...base, adminCount: 2 }), null);
  });

  it("never changes or removes the caller's own membership", () => {
    const self = { actorId: ME, targetId: ME, targetRole: "admin" as const, adminCount: 3 };
    assert.match(roleChangeError({ ...self, nextRole: "maintainer" }) ?? "", /your own role/);
    assert.match(removalError(self) ?? "", /Leave organisation/);
  });

  it("lets any role leave except the last Admin", () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      assert.equal(leaveError({ role, adminCount: 0 }), null, role);
    }
    assert.match(leaveError({ role: "admin", adminCount: 1 }) ?? "", /last Admin/);
    assert.equal(leaveError({ role: "admin", adminCount: 2 }), null);
  });
});

describe("inviteMember", () => {
  it("refuses every role without members.manage before touching anything", async () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      const { actions, calls } = setup({ role });
      const res = await actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
      assert.equal(res.ok, false, role);
      assert.deepEqual(calls, ["guard"]);
    }
  });

  it("refuses the Auditor role on a plan without it, and grants it on Team", async () => {
    const free = setup();
    assert.deepEqual(await free.actions.inviteMember({ email: "a@acme.test", role: "auditor" }), {
      ok: false,
      error: AUDITOR_PLAN_ERROR,
    });
    assert.deepEqual(mutations(free.calls), []);

    const team = setup({ org: TEAM_ORG });
    const res = await team.actions.inviteMember({ email: "a@acme.test", role: "auditor" });
    assert.equal(res.ok, true);
    assert.deepEqual(mutations(team.calls), ["insertInvite:auditor"]);
  });

  it("refuses a malformed address, an unknown role and an existing member", async () => {
    const { actions, calls } = setup({ emails: { [OTHER]: "Taken@Acme.test" } });
    assert.equal((await actions.inviteMember({ email: "not-an-email", role: "maintainer" })).ok, false);
    assert.equal((await actions.inviteMember({ email: "a@acme.test", role: "owner" })).ok, false);
    const dup = await actions.inviteMember({ email: " taken@acme.TEST ", role: "maintainer" });
    assert.deepEqual(dup, { ok: false, error: "That person is already a member of this organisation." });
    assert.deepEqual(mutations(calls), []);
  });

  it("audits first, replaces a pending invite, emails it, then returns the share link", async () => {
    const { actions, calls, audits } = setup();
    const res = await actions.inviteMember({ email: "New@Acme.test", role: "billing_manager" });
    assert.deepEqual(res, { ok: true, inviteUrl: "https://terragram.test/invite/tok", emailed: true });
    assert.deepEqual(
      calls.filter((c) => !c.startsWith("revalidate")),
      [
        "guard",
        "audit:member.invite",
        "deletePendingInviteByEmail",
        "insertInvite:billing_manager",
        "sendInviteEmail:new@acme.test",
      ],
    );
    assert.deepEqual(audits[0], {
      orgId: "org-1",
      actorId: ME,
      actorEmail: "me@acme.test",
      actorType: "member",
      action: "member.invite",
      targetType: "invite",
      targetId: INVITE,
      targetLabel: "new@acme.test",
      metadata: { role: "billing_manager", invited_by_user_id: ME, invited_by_email: "me@acme.test" },
    });
  });

  it("creates nothing when the audit row can't be written", async () => {
    const { actions, calls } = setup({ recordAudit: async () => false });
    const res = await actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
    assert.equal(res.ok, false);
    assert.deepEqual(mutations(calls), []);
    assert.equal(calls.includes("deletePendingInviteByEmail"), false);
  });

  it("emails the invitee the link it returns, with the org, role and inviter", async () => {
    let sent: Parameters<MemberActionDeps["sendInviteEmail"]>[0] | undefined;
    const { actions } = setup({
      org: { ...FREE_ORG, name: "Acme Ltd" },
      sendInviteEmail: async (params) => {
        sent = params;
        return true;
      },
    });
    await actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
    assert.deepEqual(sent, {
      to: "new@acme.test",
      inviteUrl: "https://terragram.test/invite/tok",
      orgName: "Acme Ltd",
      role: "maintainer",
      invitedBy: "me@acme.test",
    });
  });

  it("names the org by its login when it has no display name", async () => {
    let orgName: string | undefined;
    const { actions } = setup({
      sendInviteEmail: async (params) => {
        orgName = params.orgName;
        return true;
      },
    });
    await actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
    assert.equal(orgName, "acme");
  });

  it("still creates the invite and returns the link when email is not configured or the send fails", async () => {
    // `false` is both "no SES configured" and "SES refused it": either way the
    // invite stands and the Admin is told the email did not go out.
    const { actions, calls, audits } = setup({ sendInviteEmail: async () => false });
    const res = await actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
    assert.deepEqual(res, { ok: true, inviteUrl: "https://terragram.test/invite/tok", emailed: false });
    assert.deepEqual(mutations(calls), ["insertInvite:maintainer"]);
    assert.deepEqual(
      audits.map((a) => a.action),
      ["member.invite"],
      "a failed email is not a failed invite",
    );
    assert.ok(calls.includes("revalidate:/members"));
  });

  it("treats a sender that throws as not sent, never as a failed invite", async () => {
    const { actions, calls, audits } = setup({
      sendInviteEmail: async () => {
        throw new Error("SES unreachable");
      },
    });
    const res = await actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
    assert.deepEqual(res, { ok: true, inviteUrl: "https://terragram.test/invite/tok", emailed: false });
    assert.deepEqual(mutations(calls), ["insertInvite:maintainer"]);
    assert.deepEqual(
      audits.map((a) => a.action),
      ["member.invite"],
    );
  });

  it("sends no email for an invite that was refused or not written", async () => {
    for (const over of [
      { recordAudit: async () => false },
      { insertInvite: async () => false },
    ] satisfies Partial<MemberActionDeps>[]) {
      const { actions, calls } = setup(over);
      assert.equal((await actions.inviteMember({ email: "new@acme.test", role: "maintainer" })).ok, false);
      assert.equal(calls.some((c) => c.startsWith("sendInviteEmail")), false);
    }
    const refused = setup({ role: "maintainer" });
    await refused.actions.inviteMember({ email: "new@acme.test", role: "maintainer" });
    assert.equal(refused.calls.some((c) => c.startsWith("sendInviteEmail")), false);
  });

  it("records a failed insert beside the invite row", async () => {
    const { actions, audits } = setup({ insertInvite: async () => false });
    assert.equal((await actions.inviteMember({ email: "new@acme.test", role: "maintainer" })).ok, false);
    assert.deepEqual(
      audits.map((a) => [a.action, a.metadata]),
      [
        ["member.invite", audits[0]?.metadata],
        ["member.change_failed", { attempted: "member.invite", reason: "insert_failed" }],
      ],
    );
  });
});

describe("revokeInvite", () => {
  it("audits, then deletes the org's pending invite", async () => {
    const { actions, calls, audits } = setup();
    assert.deepEqual(await actions.revokeInvite(INVITE), { ok: true });
    assert.deepEqual(
      calls.filter((c) => !c.startsWith("revalidate")),
      ["guard", "audit:member.invite_revoke", "deletePendingInvite"],
    );
    assert.equal(audits[0]?.targetLabel, "new@acme.test");
  });

  it("refuses an invite that is not this org's pending one, writing nothing", async () => {
    const { actions, calls } = setup({ getPendingInvite: async () => null });
    assert.equal((await actions.revokeInvite(INVITE)).ok, false);
    assert.equal((await actions.revokeInvite("not-a-uuid")).ok, false);
    assert.deepEqual(calls, ["guard", "guard"]);
  });

  it("records an invite accepted between the read and the delete", async () => {
    const { actions, audits } = setup({ deletePendingInvite: async () => false });
    assert.equal((await actions.revokeInvite(INVITE)).ok, false);
    assert.deepEqual(
      audits.map((a) => a.action),
      ["member.invite_revoke", "member.change_failed"],
    );
  });
});

describe("changeMemberRole", () => {
  it("refuses every role without members.manage", async () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      const { actions, calls } = setup({ role });
      assert.equal((await actions.changeMemberRole({ userId: OTHER, role: "admin" })).ok, false);
      assert.deepEqual(calls, ["guard"]);
    }
  });

  it("audits the change with from/to before making it", async () => {
    const { actions, calls, audits } = setup();
    assert.deepEqual(await actions.changeMemberRole({ userId: OTHER, role: "admin" }), { ok: true });
    assert.ok(
      calls.indexOf("audit:member.role_change") < calls.indexOf(`updateMembershipRole:${OTHER}:admin`),
    );
    assert.deepEqual(audits[0]?.metadata, { from: "maintainer", to: "admin" });
    assert.ok(calls.includes("revalidate:/settings"), "the transfer candidates are refreshed");
  });

  it("demotes another Admin, but never the caller's own role or to the Auditor off-plan", async () => {
    const twoAdmins = setup({ members: { [ME]: "admin", [OTHER]: "admin" } });
    assert.equal((await twoAdmins.actions.changeMemberRole({ userId: OTHER, role: "maintainer" })).ok, true);

    const own = setup();
    assert.equal((await own.actions.changeMemberRole({ userId: ME, role: "maintainer" })).ok, false);

    const auditor = setup();
    assert.equal((await auditor.actions.changeMemberRole({ userId: OTHER, role: "auditor" })).ok, false);

    for (const { calls } of [own, auditor]) assert.deepEqual(mutations(calls), []);
  });

  it("is a no-op for the role the member already has, and refuses a stranger", async () => {
    const { actions, calls } = setup();
    assert.deepEqual(await actions.changeMemberRole({ userId: OTHER, role: "maintainer" }), { ok: true });
    assert.equal((await actions.changeMemberRole({ userId: THIRD, role: "admin" })).ok, false);
    assert.deepEqual(mutations(calls), []);
    assert.equal(calls.some((c) => c.startsWith("audit")), false);
  });

  it("changes nothing when the audit row can't be written", async () => {
    const { actions, calls } = setup({ recordAudit: async () => false });
    assert.equal((await actions.changeMemberRole({ userId: OTHER, role: "admin" })).ok, false);
    assert.deepEqual(mutations(calls), []);
  });

  it("reports the database's last-Admin refusal and records it", async () => {
    const { actions, audits } = setup({ updateMembershipRole: async () => "last_admin" });
    const res = await actions.changeMemberRole({ userId: OTHER, role: "admin" });
    assert.equal(res.ok, false);
    assert.deepEqual(audits.at(-1)?.metadata, { attempted: "member.role_change", reason: "last_admin" });
  });
});

describe("removeMember", () => {
  it("audits, then removes through set_membership", async () => {
    const { actions, calls, audits } = setup();
    assert.deepEqual(await actions.removeMember(OTHER), { ok: true });
    assert.ok(calls.indexOf("audit:member.remove") < calls.indexOf(`deleteMembership:${OTHER}`));
    assert.deepEqual(audits[0]?.metadata, { role: "maintainer" });
  });

  it("is idempotent for someone who is not a member", async () => {
    const { actions, calls } = setup();
    assert.deepEqual(await actions.removeMember(THIRD), { ok: true });
    assert.deepEqual(mutations(calls), []);
  });

  it("refuses the caller themselves, writing nothing", async () => {
    const { actions, calls } = setup();
    assert.equal((await actions.removeMember(ME)).ok, false);
    assert.deepEqual(mutations(calls), []);
    assert.equal(calls.some((c) => c.startsWith("audit")), false);
  });

  it("reports the database's last-Admin refusal (a concurrent demotion) and records it", async () => {
    const { actions, audits } = setup({
      members: { [ME]: "admin", [OTHER]: "admin" },
      deleteMembership: async () => "last_admin",
    });
    const res = await actions.removeMember(OTHER);
    assert.deepEqual(res, { ok: false, error: "This is the last Admin. Make someone else an Admin first." });
    assert.deepEqual(
      audits.map((a) => a.action),
      ["member.remove", "member.change_failed"],
    );
  });

  it("changes nothing when the audit row can't be written", async () => {
    const { actions, calls } = setup({ recordAudit: async () => false });
    assert.equal((await actions.removeMember(OTHER)).ok, false);
    assert.deepEqual(mutations(calls), []);
  });

  it("syncs the seat count after the removal, and only when it happened", async () => {
    const removed = setup();
    await removed.actions.removeMember(OTHER);
    assert.ok(
      removed.calls.indexOf(`deleteMembership:${OTHER}`) < removed.calls.indexOf("syncSeats:org-1:member.remove"),
    );

    const refused = setup({ members: { [ME]: "admin", [OTHER]: "admin" }, deleteMembership: async () => "last_admin" });
    await refused.actions.removeMember(OTHER);
    assert.equal(refused.calls.some((c) => c.startsWith("syncSeats")), false);
  });
});

describe("leaveOrganisation", () => {
  it("lets any role leave, audited first, with no capability check", async () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      const { actions, calls } = setup({ role, members: { [ME]: role, [OTHER]: "admin" } });
      assert.deepEqual(await actions.leaveOrganisation(), { ok: true }, role);
      assert.equal(calls.includes("guard"), false);
      assert.ok(calls.indexOf("audit:member.leave") < calls.indexOf(`deleteMembership:${ME}`));
    }
  });

  it("refuses the last Admin before writing anything", async () => {
    const { actions, calls } = setup({ members: { [ME]: "admin", [OTHER]: "maintainer" } });
    const res = await actions.leaveOrganisation();
    assert.equal(res.ok, false);
    assert.deepEqual(calls, ["rateLimit:members:leave"]);
  });

  it("lets an Admin leave when another Admin remains", async () => {
    const { actions } = setup({ members: { [ME]: "admin", [OTHER]: "admin" } });
    assert.deepEqual(await actions.leaveOrganisation(), { ok: true });
  });

  it("refuses a signed-out caller and stays put when the audit row can't be written", async () => {
    const signedOut = setup({ getCurrentMembership: async () => null });
    assert.equal((await signedOut.actions.leaveOrganisation()).ok, false);
    const unaudited = setup({ role: "maintainer", recordAudit: async () => false });
    assert.equal((await unaudited.actions.leaveOrganisation()).ok, false);
    assert.deepEqual(mutations(unaudited.calls), []);
  });
});

describe("leaveOrganisation: seats", () => {
  it("syncs the seat count after leaving, and not when leaving was refused", async () => {
    const left = setup({ role: "maintainer", members: { [ME]: "maintainer", [OTHER]: "admin" } });
    assert.deepEqual(await left.actions.leaveOrganisation(), { ok: true });
    assert.ok(left.calls.indexOf(`deleteMembership:${ME}`) < left.calls.indexOf("syncSeats:org-1:member.leave"));

    const lastAdmin = setup({ members: { [ME]: "admin" } });
    assert.equal((await lastAdmin.actions.leaveOrganisation()).ok, false);
    assert.equal(lastAdmin.calls.some((c) => c.startsWith("syncSeats")), false);
  });
});

describe("acceptInvite", () => {
  it("rejects a non-token without reaching the database, and refreshes on a join", async () => {
    let reached = 0;
    const { actions, calls } = setup({
      acceptInviteByToken: async () => {
        reached++;
        return { status: "joined", orgLabel: "acme", orgId: "org-2" };
      },
    });
    assert.deepEqual(await actions.acceptInvite("   "), { status: "invalid" });
    assert.deepEqual(await actions.acceptInvite(42 as unknown as string), { status: "invalid" });
    assert.equal(reached, 0);
    assert.deepEqual(await actions.acceptInvite("tok"), { status: "joined", orgLabel: "acme", orgId: "org-2" });
    assert.ok(calls.includes("revalidate:/members"));
  });

  it("makes the joined org the active one, and the org of a link the caller already belongs to", async () => {
    const joined = setup();
    await joined.actions.acceptInvite("tok");
    assert.ok(joined.calls.includes("setActiveOrg:org-2"));

    const already = setup({
      acceptInviteByToken: async () => ({ status: "already-member", orgLabel: "acme", orgId: "org-3" }),
    });
    await already.actions.acceptInvite("tok");
    assert.deepEqual(already.calls, ["setActiveOrg:org-3"]);
  });

  it("leaves the active org alone when nothing was joined", async () => {
    for (const status of ["invalid", "expired", "signed-out"] as const) {
      const { actions, calls } = setup({ acceptInviteByToken: async () => ({ status }) });
      await actions.acceptInvite("tok");
      assert.deepEqual(calls, [], status);
    }
    const refused = setup({
      acceptInviteByToken: async () => ({ status: "role-unavailable", error: "no" }),
    });
    await refused.actions.acceptInvite("tok");
    assert.deepEqual(refused.calls, []);
  });
});
