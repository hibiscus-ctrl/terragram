/**
 * Managed-model entitlement (`payg`) is decoupled from tier/access: a `past_due`
 * org keeps its tier through the grace period but stops accruing managed Bedrock spend.
 * Pure; run with `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { downgradeSchedule, grantsManaged, keepsTier } from "../src/features/billing/subscription-status.ts";

describe("subscription-status", () => {
  it("active / trialing keep tier AND grant managed", () => {
    for (const s of ["active", "trialing"]) {
      assert.equal(keepsTier(s), true, `${s} keepsTier`);
      assert.equal(grantsManaged(s), true, `${s} grantsManaged`);
    }
  });

  it("past_due keeps tier (grace) but does NOT grant managed (the spend leak)", () => {
    assert.equal(keepsTier("past_due"), true);
    assert.equal(grantsManaged("past_due"), false);
  });

  it("terminal states grant neither", () => {
    for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      assert.equal(keepsTier(s), false, `${s} keepsTier`);
      assert.equal(grantsManaged(s), false, `${s} grantsManaged`);
    }
  });
});

describe("downgradeSchedule", () => {
  it("reports a scheduled downgrade with its period-end date", () => {
    const cancelAt = 1_790_000_000;
    assert.deepEqual(downgradeSchedule({ cancel_at_period_end: true, cancel_at: cancelAt }), {
      cancelAtPeriodEnd: true,
      planEndsAtIso: new Date(cancelAt * 1000).toISOString(),
    });
  });

  it("reports not-scheduled when the flag is off or the timestamp is missing", () => {
    assert.deepEqual(downgradeSchedule({ cancel_at_period_end: false, cancel_at: null }), {
      cancelAtPeriodEnd: false,
      planEndsAtIso: null,
    });
    assert.deepEqual(downgradeSchedule({ cancel_at_period_end: true, cancel_at: null }), {
      cancelAtPeriodEnd: false,
      planEndsAtIso: null,
    });
  });
});
