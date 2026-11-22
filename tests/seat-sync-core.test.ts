/**
 * The seat-sync decision. Pinned: only a live subscription with a per-seat Team
 * line is ever updated — free/OSS, PAYG-only, cancelled and foreign subscriptions
 * are skipped — an equal quantity is left alone, the quantity is never pushed
 * below one, and the idempotency key cannot replay a later, legitimate change.
 * No Stripe calls: the decision is pure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STRIPE_LOOKUP_KEYS } from "../src/config/pricing.ts";
import {
  planSeatSync,
  type SeatSubscription,
  seatSyncIdempotencyKey,
} from "../src/features/billing/seat-sync-core.ts";

const LK = STRIPE_LOOKUP_KEYS;

function sub(over: Partial<SeatSubscription> = {}, teamQuantity: number | null = 3): SeatSubscription {
  return {
    id: "sub_1",
    status: "active",
    items: [
      { id: "si_team", lookupKey: LK.teamMonthly, quantity: teamQuantity },
      { id: "si_meter", lookupKey: LK.managedCost, quantity: null },
    ],
    ...over,
  };
}

describe("planSeatSync", () => {
  it("updates the Team line to the seat count when they differ, in either direction", () => {
    assert.deepEqual(planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub(), seats: 4 }), {
      action: "update",
      itemId: "si_team",
      seats: 4,
      quantity: 3,
    });
    const down = planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub(), seats: 2 });
    assert.equal(down.action, "update");
    assert.equal(down.seats, 2);
  });

  it("finds the annual Team line too", () => {
    const annual = sub({ items: [{ id: "si_year", lookupKey: LK.teamAnnual, quantity: 5 }] });
    const plan = planSeatSync({ orgSubscriptionId: "sub_1", subscription: annual, seats: 6 });
    assert.equal(plan.action === "update" && plan.itemId, "si_year");
  });

  it("leaves an equal quantity alone", () => {
    assert.deepEqual(planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub(), seats: 3 }), {
      action: "skip",
      reason: "in_sync",
      seats: 3,
      quantity: 3,
    });
  });

  it("skips a free/OSS org with no subscription", () => {
    const plan = planSeatSync({ orgSubscriptionId: null, subscription: null, seats: 5 });
    assert.equal(plan.action === "skip" && plan.reason, "no_subscription");
  });

  it("skips a subscription that is not the org's own", () => {
    const plan = planSeatSync({ orgSubscriptionId: "sub_other", subscription: sub(), seats: 5 });
    assert.equal(plan.action === "skip" && plan.reason, "subscription_mismatch");
  });

  it("skips a subscription that bills no seats: PAYG only, or no Team line", () => {
    const payg = sub({ items: [{ id: "si_payg", lookupKey: LK.payg, quantity: 1 }] });
    const plan = planSeatSync({ orgSubscriptionId: "sub_1", subscription: payg, seats: 5 });
    assert.equal(plan.action === "skip" && plan.reason, "no_seat_line");
  });

  it("skips a subscription that is no longer live, but keeps syncing through past_due", () => {
    for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
      const plan = planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub({ status }), seats: 5 });
      assert.equal(plan.action === "skip" && plan.reason, "not_live", status);
    }
    for (const status of ["active", "trialing", "past_due"]) {
      const plan = planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub({ status }), seats: 5 });
      assert.equal(plan.action, "update", status);
    }
  });

  it("never pushes a quantity below one", () => {
    const plan = planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub({}, 2), seats: 0 });
    assert.equal(plan.action === "update" && plan.seats, 1);
    const atOne = planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub({}, 1), seats: -3 });
    assert.equal(atOne.action === "skip" && atOne.reason, "in_sync");
  });

  it("sets a Team line that carries no quantity", () => {
    const plan = planSeatSync({ orgSubscriptionId: "sub_1", subscription: sub({}, null), seats: 2 });
    assert.deepEqual(plan, { action: "update", itemId: "si_team", seats: 2, quantity: null });
  });
});

describe("seatSyncIdempotencyKey", () => {
  const now = new Date("2026-10-10T14:25:00.000Z");

  it("is derived from the org and the new count, so a retry of one change is deduplicated", () => {
    assert.equal(seatSyncIdempotencyKey("org-1", 3, 4, now), seatSyncIdempotencyKey("org-1", 3, 4, now));
    assert.match(seatSyncIdempotencyKey("org-1", 3, 4, now), /org-1/);
    assert.notEqual(seatSyncIdempotencyKey("org-1", 3, 4, now), seatSyncIdempotencyKey("org-2", 3, 4, now));
    assert.notEqual(seatSyncIdempotencyKey("org-1", 3, 4, now), seatSyncIdempotencyKey("org-1", 3, 5, now));
  });

  it("does not replay an earlier change to the same count from another quantity or hour", () => {
    const first = seatSyncIdempotencyKey("org-1", 3, 4, now);
    assert.notEqual(first, seatSyncIdempotencyKey("org-1", 5, 4, now));
    assert.notEqual(first, seatSyncIdempotencyKey("org-1", 3, 4, new Date("2026-10-10T15:00:00.000Z")));
    assert.equal(first, seatSyncIdempotencyKey("org-1", 3, 4, new Date("2026-10-10T14:59:59.999Z")));
  });

  it("fits Stripe's 255-character limit", () => {
    const longest = seatSyncIdempotencyKey("00000000-0000-4000-8000-000000000000", null, 100_000, now);
    assert.ok(longest.length <= 255);
  });
});
