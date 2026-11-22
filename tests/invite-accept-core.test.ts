/**
 * Invite acceptance is single-use: CLAIM (a compare-and-set on `accepted_at IS
 * NULL`) before JOIN, so of two concurrent acceptances only the one whose claim
 * flipped the row is given a membership. It used to join first and stamp
 * `accepted_at` unconditionally, so both holders of one link joined.
 *
 * Also pinned: a role the org's current plan no longer includes is refused before
 * the claim (so the invite stays pending), the new membership records who invited
 * them, and the join is audited once, only when a membership was created.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  claimThenJoin,
  type InviteClaimDeps,
  type JoinLineage,
} from "../src/features/app/invite-accept-core.ts";
import type { AuditEntry } from "../src/features/platform/audit-events.ts";

const INVITE = {
  id: "inv-1",
  org_id: "org-1",
  role: "maintainer",
  repo_ids: ["repo-1"],
  invited_by: "admin@acme.test",
  invited_by_user_id: "admin-1",
};
const USER = { id: "user-1", email: "new@acme.test" };
const NOW = "2026-10-10T00:00:00.000Z";

/** An in-memory `org_invites` row whose claim is a real compare-and-set. */
function fakes(over: { joinResult?: { created: boolean } | null; auditorEntitled?: boolean } = {}) {
  const row: { accepted_at: string | null; accepted_by: string | null } = {
    accepted_at: null,
    accepted_by: null,
  };
  const joins: [string, string, string, string[] | undefined, JoinLineage][] = [];
  const audits: AuditEntry[] = [];
  const calls: string[] = [];
  const deps: InviteClaimDeps<string> = {
    claimInvite: async (_id, userId, nowIso) => {
      calls.push("claim");
      // Yield first, so two concurrent callers both reach the check.
      await Promise.resolve();
      if (row.accepted_at !== null) return false;
      row.accepted_at = nowIso;
      row.accepted_by = userId;
      return true;
    },
    releaseInvite: async (_id, userId) => {
      calls.push("release");
      if (row.accepted_by === userId) {
        row.accepted_at = null;
        row.accepted_by = null;
      }
    },
    joinOrg: async (userId, orgId, role, repoIds, lineage) => {
      calls.push("join");
      joins.push([userId, orgId, role, repoIds, lineage]);
      return over.joinResult === undefined ? { created: true } : over.joinResult;
    },
    recordAudit: async (entry) => {
      calls.push("audit");
      audits.push(entry);
    },
    auditorEntitled: async (orgId) => {
      calls.push(`auditorEntitled:${orgId}`);
      return over.auditorEntitled ?? true;
    },
  };
  return { deps, row, joins, audits, calls };
}

describe("claimThenJoin", () => {
  it("claims before joining, and joins with the invite's role, repo restriction and inviter", async () => {
    const { deps, row, joins, calls } = fakes();
    assert.equal(await claimThenJoin(deps, INVITE, USER, NOW, "invite_link"), "joined");
    assert.deepEqual(calls, ["claim", "join", "audit"]);
    assert.deepEqual(joins, [
      ["user-1", "org-1", "maintainer", ["repo-1"], { invitedBy: "admin-1", invitedByEmail: "admin@acme.test" }],
    ]);
    assert.deepEqual(row, { accepted_at: NOW, accepted_by: "user-1" });
  });

  it("gives exactly ONE of two concurrent acceptances a membership", async () => {
    const { deps, row, joins, audits } = fakes();
    const outcomes = await Promise.all([
      claimThenJoin(deps, INVITE, { id: "user-a", email: "a@acme.test" }, NOW, "invite_link"),
      claimThenJoin(deps, INVITE, { id: "user-b", email: "b@acme.test" }, NOW, "invite_link"),
    ]);
    assert.deepEqual([...outcomes].sort(), ["joined", "lost"]);
    assert.equal(joins.length, 1, "the losing caller must not join");
    assert.equal(audits.length, 1, "nor be recorded as joining");
    assert.equal(row.accepted_by, joins[0]?.[0], "the invite is stamped by the one who joined");
  });

  it("does not join, or record anything, on an invite someone already claimed", async () => {
    const { deps, row, joins, audits } = fakes();
    row.accepted_at = NOW;
    row.accepted_by = "someone-else";
    assert.equal(await claimThenJoin(deps, INVITE, USER, NOW, "invite_link"), "lost");
    assert.equal(joins.length, 0);
    assert.equal(audits.length, 0);
  });

  it("releases the claim when the membership write fails, and records no join", async () => {
    const { deps, row, calls, audits } = fakes({ joinResult: null });
    assert.equal(await claimThenJoin(deps, INVITE, USER, NOW, "invite_link"), "failed");
    assert.deepEqual(calls, ["claim", "join", "release"]);
    assert.deepEqual(row, { accepted_at: null, accepted_by: null });
    assert.equal(audits.length, 0);
  });

  it("audits the join: who joined, how, with what role, and who invited them", async () => {
    const { deps, audits } = fakes();
    await claimThenJoin(deps, INVITE, USER, NOW, "invite_on_sign_in");
    assert.deepEqual(audits, [
      {
        orgId: "org-1",
        actorId: "user-1",
        actorEmail: "new@acme.test",
        actorType: "member",
        action: "member.join",
        targetType: "member",
        targetId: "user-1",
        targetLabel: "new@acme.test",
        metadata: {
          via: "invite_on_sign_in",
          invite_id: "inv-1",
          role: "maintainer",
          repo_grants: 1,
          invited_by_user_id: "admin-1",
          invited_by_email: "admin@acme.test",
        },
      },
    ]);
  });

  it("records no join for someone who was already a member", async () => {
    const { deps, audits } = fakes({ joinResult: { created: false } });
    assert.equal(await claimThenJoin(deps, INVITE, USER, NOW, "invite_link"), "joined");
    assert.equal(audits.length, 0);
  });

  it("passes no repo restriction for an invite without one", async () => {
    const { deps, joins, audits } = fakes();
    await claimThenJoin(deps, { ...INVITE, repo_ids: null }, USER, NOW, "invite_link");
    assert.equal(joins[0]?.[3], undefined);
    assert.equal(audits[0]?.metadata && (audits[0].metadata as { repo_grants: number }).repo_grants, 0);
  });

  it("REFUSES an Auditor invite once the org's plan no longer includes the role — unclaimed, so it stays pending", async () => {
    for (const via of ["invite_link", "invite_on_sign_in"] as const) {
      const { deps, row, joins, audits, calls } = fakes({ auditorEntitled: false });
      assert.equal(await claimThenJoin(deps, { ...INVITE, role: "auditor" }, USER, NOW, via), "refused");
      assert.deepEqual(calls, ["auditorEntitled:org-1"]);
      assert.deepEqual(row, { accepted_at: null, accepted_by: null });
      assert.equal(joins.length, 0);
      assert.equal(audits.length, 0);
    }
  });

  it("admits an Auditor invite while the plan still includes the role", async () => {
    const { deps, joins } = fakes({ auditorEntitled: true });
    assert.equal(await claimThenJoin(deps, { ...INVITE, role: "auditor" }, USER, NOW, "invite_link"), "joined");
    assert.equal(joins[0]?.[2], "auditor");
  });

  it("does not consult the plan for a non-Auditor invite", async () => {
    const { deps, calls } = fakes({ auditorEntitled: false });
    assert.equal(await claimThenJoin(deps, INVITE, USER, NOW, "invite_link"), "joined");
    assert.equal(calls.some((c) => c.startsWith("auditorEntitled")), false);
  });
});
