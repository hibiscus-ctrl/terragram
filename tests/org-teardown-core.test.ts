// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The org teardown a confirmed deletion ends in. Pinned: the row is deleted FIRST
 * and a failed delete leaves billing alone (the org still exists); the
 * subscription is cancelled only afterwards; and a cancellation Stripe does not
 * confirm is audited (org id null — the row is gone) and reported, never swallowed
 * and never undoing the deletion.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeOrgTeardown, type OrgTeardownDeps } from "../src/features/app/org-teardown-core.ts";

const ORG = { id: "org-1", github_login: "acme", stripe_subscription_id: "sub_1" };
const ACTOR = { id: "user-1", email: "admin@acme.test", type: "member" as const };

function setup(over: Partial<OrgTeardownDeps> = {}) {
  const calls: Array<[string, unknown]> = [];
  const deps: OrgTeardownDeps = {
    deleteOrgRow: async (id) => {
      calls.push(["deleteOrgRow", id]);
      return true;
    },
    cancelSubscription: async (id) => {
      calls.push(["cancelSubscription", id]);
      return true;
    },
    recordAudit: async (entry) => {
      calls.push(["recordAudit", entry]);
      return true;
    },
    ...over,
  };
  return { teardown: makeOrgTeardown(deps), calls };
}

describe("teardownOrg", () => {
  it("deletes the row, THEN cancels billing — and audits nothing extra on success", async () => {
    const { teardown, calls } = setup();
    assert.deepEqual(await teardown(ORG, ACTOR), { ok: true, subscriptionNotCancelled: null });
    assert.deepEqual(calls, [
      ["deleteOrgRow", "org-1"],
      ["cancelSubscription", "sub_1"],
    ]);
  });

  it("leaves billing alone when the delete fails — the org still exists", async () => {
    const { teardown, calls } = setup({ deleteOrgRow: async () => false });
    assert.deepEqual(await teardown(ORG, ACTOR), { ok: false });
    assert.deepEqual(calls, []);
  });

  it("skips Stripe for an org with no subscription", async () => {
    const { teardown, calls } = setup();
    await teardown({ ...ORG, stripe_subscription_id: null }, ACTOR);
    assert.deepEqual(calls, [["deleteOrgRow", "org-1"]]);
  });

  it("reports and audits a cancellation Stripe did not confirm, without undoing the delete", async () => {
    const { teardown, calls } = setup({ cancelSubscription: async () => false });
    assert.deepEqual(await teardown(ORG, ACTOR), { ok: true, subscriptionNotCancelled: "sub_1" });
    assert.deepEqual(
      calls.filter(([n]) => n === "recordAudit").map(([, e]) => e),
      [
        {
          orgId: null,
          actorId: "user-1",
          actorEmail: "admin@acme.test",
          actorType: "member",
          action: "org.subscription_cancel_failed",
          targetType: "org",
          targetId: "org-1",
          targetLabel: "acme",
          metadata: { subscription: "sub_1" },
        },
      ],
    );
  });
});
