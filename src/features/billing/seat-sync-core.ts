import { isTeamBaseLookupKey } from "./plan-prices.ts";
import { keepsTier } from "./subscription-status.ts";

/**
 * Keeping the Team subscription's seat quantity equal to the org's member count.
 * Pure: what to do, given the org's subscription as Stripe reports it and the seat
 * count as the database reports it. `seat-sync.ts` fetches both, applies the
 * decision and audits it.
 *
 * Only a paid, seat-based subscription is touched: a LIVE subscription (the
 * statuses that keep the tier, `past_due` included) carrying a Team base line,
 * which is the per-seat, graduated-banded price. A free/OSS org, a PAYG-only one
 * (its £0 base is a single unit, not seats) and an Enterprise contract without a
 * Team line are skipped without a write.
 *
 * Membership changes are not serialised against each other, so two concurrent ones
 * can each push the count they saw and leave the later-read one behind. That is
 * drift, not damage: the reconcile (a billing-page view, the subscription webhook)
 * compares again and fixes it.
 */

/** The subscription fields the decision reads. */
export type SeatSubscription = {
  id: string;
  status: string;
  items: { id: string; lookupKey: string | null | undefined; quantity: number | null | undefined }[];
};

type SeatSyncSkipReason =
  /** The org has no subscription on record. */
  | "no_subscription"
  /** The subscription Stripe returned is not the one the org has on record. */
  | "subscription_mismatch"
  /** Cancelled, incomplete or unpaid: nothing to bill seats against. */
  | "not_live"
  /** No per-seat Team line (PAYG only, or an Enterprise contract). */
  | "no_seat_line"
  /** Stripe already bills exactly the current seat count. */
  | "in_sync";

export type SeatSyncPlan =
  | { action: "skip"; reason: SeatSyncSkipReason; seats: number; quantity: number | null }
  | { action: "update"; itemId: string; seats: number; quantity: number | null };

/**
 * What to do about the org's seat quantity. `seats` is floored at 1 because a
 * subscription item needs a quantity of at least one — and an org always keeps an
 * Admin, so a real count is never zero.
 */
export function planSeatSync(input: {
  orgSubscriptionId: string | null;
  subscription: SeatSubscription | null;
  seats: number;
}): SeatSyncPlan {
  const seats = Math.max(1, Math.floor(input.seats));
  const skip = (reason: SeatSyncSkipReason, quantity: number | null = null): SeatSyncPlan => ({
    action: "skip",
    reason,
    seats,
    quantity,
  });

  if (!input.orgSubscriptionId || !input.subscription) return skip("no_subscription");
  if (input.subscription.id !== input.orgSubscriptionId) return skip("subscription_mismatch");
  if (!keepsTier(input.subscription.status)) return skip("not_live");

  const line = input.subscription.items.find((item) => isTeamBaseLookupKey(item.lookupKey));
  if (!line) return skip("no_seat_line");

  const quantity = line.quantity ?? null;
  if (quantity === seats) return skip("in_sync", quantity);
  return { action: "update", itemId: line.id, seats, quantity };
}

/**
 * The Stripe idempotency key for setting an org's seat quantity: derived from the
 * org, the quantity being replaced, the new one and the UTC hour.
 *
 * Stripe REPLAYS a request whose key it has seen in the last 24 hours instead of
 * running it. A key of the org and the new count alone would therefore swallow a
 * legitimate change back to a count the org had earlier that day (3 → 4 → 3 → 4:
 * the second "→ 4" would be answered from the cache and do nothing). Including the
 * old quantity and the hour narrows that to a flip-flop inside one hour, which the
 * next reconcile then corrects; a retry of the same change is still deduplicated.
 */
export function seatSyncIdempotencyKey(
  orgId: string,
  from: number | null,
  to: number,
  now: Date,
): string {
  const hour = now.toISOString().slice(0, 13);
  return `terragram-seats:${orgId}:${from ?? "none"}->${to}:${hour}`;
}
