// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The org-lifecycle actions behind injected collaborators. Pinned: the capability
 * each one requires, the typed confirmation, that the scarce limit is spent only
 * after it matches, that a transfer only goes to another Admin of the same org and
 * removes the initiator, and that a delete or a transfer whose audit record can't
 * be written changes nothing — with the actor's id on every row.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OrgMembership } from "../src/features/account/controllers/get-or-create-org.ts";
import type { OrgRole } from "../src/features/account/controllers/permissions.ts";
import { makeOrgActions, type OrgActionDeps } from "../src/features/app/org-core.ts";
import type { AuditEntry } from "../src/features/platform/audit-events.ts";

const ORG = { id: "org-1", github_login: "acme", stripe_subscription_id: "sub_1" };

function setup(
  over: Partial<OrgActionDeps> & { role?: OrgRole; roles?: Record<string, OrgRole> } = {},
) {
  const calls: string[] = [];
  const audits: AuditEntry[] = [];
  const membership = { org: ORG, role: over.role ?? "admin", userId: "user-1" } as unknown as OrgMembership;
  const deps: OrgActionDeps = {
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
    getAuthenticatedUser: async () => ({ id: "user-1", email: "admin@acme.test" }),
    slugify: (v) => v.toLowerCase(),
    randomSuffix: () => "beef",
    insertOrg: async (login) => {
      calls.push(`insertOrg:${login}`);
      return { id: "org-new", github_login: login };
    },
    insertBootstrapMembership: async () => true,
    deleteOrgRow: async (id) => {
      calls.push(`deleteOrgRow:${id}`);
      return true;
    },
    teardownOrg: async (org) => {
      calls.push(`teardownOrg:${org.id}`);
      return { ok: true, subscriptionNotCancelled: null };
    },
    getMembershipRole: async (_org, userId) => over.roles?.[userId] ?? null,
    deleteMembership: async (orgId, userId) => {
      calls.push(`deleteMembership:${orgId}:${userId}`);
      return "ok";
    },
    recordAudit: async (entry) => {
      calls.push(`audit:${entry.action}`);
      audits.push(entry);
      return true;
    },
    syncSeats: async (orgId, trigger) => {
      calls.push(`syncSeats:${orgId}:${trigger}`);
    },
    revalidate: () => {},
    ...over,
  };
  return { actions: makeOrgActions(deps), calls, audits };
}

describe("deleteOrganisation", () => {
  it("refuses every role without org.delete before touching anything", async () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      const { actions, calls } = setup({ role });
      const res = await actions.deleteOrganisation("acme");
      assert.equal(res.ok, false, role);
      assert.deepEqual(calls, ["guard"]);
    }
  });

  it("does not spend the scarce limit on a mistyped confirmation", async () => {
    const { actions, calls } = setup();
    const res = await actions.deleteOrganisation("acne");
    assert.equal(res.ok, false);
    assert.deepEqual(calls, ["guard"]);
  });

  it("records the deletion, with the actor's id, before the org is touched", async () => {
    const { actions, calls, audits } = setup();
    assert.deepEqual(await actions.deleteOrganisation(" ACME "), { ok: true });
    assert.equal(calls.indexOf("audit:org.delete") < calls.indexOf("teardownOrg:org-1"), true);
    assert.deepEqual(audits[0], {
      orgId: "org-1",
      actorId: "user-1",
      actorEmail: "admin@acme.test",
      actorType: "member",
      action: "org.delete",
      targetType: "org",
      targetId: "org-1",
      targetLabel: "acme",
    });
  });

  it("changes NOTHING when the audit record can't be written", async () => {
    const { actions, calls } = setup({
      recordAudit: async () => false,
    });
    const res = await actions.deleteOrganisation("acme");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /audit/i);
    assert.equal(calls.some((c) => c.startsWith("teardownOrg")), false);
  });

  it("records a failed delete so the org.delete row does not stand alone", async () => {
    const { actions, audits } = setup({ teardownOrg: async () => ({ ok: false }) });
    const res = await actions.deleteOrganisation("acme");
    assert.equal(res.ok, false);
    assert.deepEqual(
      audits.map((a) => a.action),
      ["org.delete", "org.delete_failed"],
    );
  });

  it("reports a deletion whose subscription Stripe did not confirm cancelling", async () => {
    const { actions } = setup({
      teardownOrg: async () => ({ ok: true, subscriptionNotCancelled: "sub_1" }),
    });
    const res = await actions.deleteOrganisation("acme");
    assert.equal(res.ok, true);
    assert.match(res.ok ? (res.warning ?? "") : "", /subscription/);
  });
});

describe("transferOwnership", () => {
  const input = { userId: "user-2", confirmation: "acme" };

  it("refuses every role without org.transfer", async () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      const { actions, calls } = setup({ role, roles: { "user-2": "admin" } });
      assert.equal((await actions.transferOwnership(input)).ok, false, role);
      assert.deepEqual(calls, ["guard"]);
    }
  });

  it("refuses a recipient who is not a member of this org", async () => {
    const { actions, calls } = setup({ roles: {} });
    const res = await actions.transferOwnership(input);
    assert.match(res.error ?? "", /not a member/);
    assert.equal(calls.some((c) => c.startsWith("deleteMembership")), false);
  });

  it("refuses a recipient who is a member but not an Admin", async () => {
    for (const role of ["maintainer", "auditor", "billing_manager"] as const) {
      const { actions, calls } = setup({ roles: { "user-2": role } });
      const res = await actions.transferOwnership(input);
      assert.match(res.error ?? "", /another Admin/, role);
      assert.equal(calls.some((c) => c.startsWith("deleteMembership")), false);
    }
  });

  it("refuses handing the org to yourself", async () => {
    const { actions } = setup({ roles: { "user-1": "admin" } });
    const res = await actions.transferOwnership({ userId: "user-1", confirmation: "acme" });
    assert.equal(res.ok, false);
  });

  it("hands the org to another Admin by removing the initiator — never by minting a role", async () => {
    const { actions, calls, audits } = setup({ roles: { "user-2": "admin" } });
    assert.deepEqual(await actions.transferOwnership(input), { ok: true });
    assert.deepEqual(
      calls.filter((c) => c.startsWith("deleteMembership")),
      ["deleteMembership:org-1:user-1"],
    );
    assert.equal(calls.indexOf("audit:org.transfer_ownership") < calls.indexOf("deleteMembership:org-1:user-1"), true);
    assert.equal(audits[0]?.actorId, "user-1");
    assert.equal(audits[0]?.targetId, "user-2");
    // The initiator's seat goes with them.
    assert.ok(
      calls.indexOf("deleteMembership:org-1:user-1") < calls.indexOf("syncSeats:org-1:org.transfer_ownership"),
    );
  });

  it("changes NOTHING when the audit record can't be written", async () => {
    const { actions, calls } = setup({ roles: { "user-2": "admin" }, recordAudit: async () => false });
    const res = await actions.transferOwnership(input);
    assert.match(res.error ?? "", /audit/i);
    assert.equal(calls.some((c) => c.startsWith("deleteMembership")), false);
  });

  it("records a failed leave (e.g. the last-admin guard) next to the transfer row", async () => {
    const { actions, audits, calls } = setup({
      roles: { "user-2": "admin" },
      deleteMembership: async () => "last_admin",
    });
    assert.equal((await actions.transferOwnership(input)).ok, false);
    assert.deepEqual(
      audits.map((a) => a.action),
      ["org.transfer_ownership", "org.transfer_failed"],
    );
    assert.equal(calls.some((c) => c.startsWith("syncSeats")), false);
  });
});

describe("createOrganisation", () => {
  it("retries a colliding slug with a suffix and records the creator's id", async () => {
    let first = true;
    const { actions, audits } = setup({
      insertOrg: async (login) => {
        if (first) {
          first = false;
          return null;
        }
        return { id: "org-new", github_login: login };
      },
    });
    assert.deepEqual(await actions.createOrganisation("Acme"), { ok: true, slug: "acme-beef" });
    assert.equal(audits[0]?.action, "org.create");
    assert.equal(audits[0]?.actorId, "user-1");
  });

  it("rolls the org back when its bootstrap membership can't be written", async () => {
    const { actions, calls } = setup({ insertBootstrapMembership: async () => false });
    assert.equal((await actions.createOrganisation("Acme")).ok, false);
    assert.ok(calls.includes("deleteOrgRow:org-new"));
  });
});
