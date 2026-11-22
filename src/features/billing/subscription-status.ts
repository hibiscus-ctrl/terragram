// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe subscription-status classification for entitlement. Pure, dependency-free
 * (no `@/` / `stripe` imports) so it's unit-testable and the two questions — "does this
 * keep tier/access?" vs "does this grant managed models?" — have one definition each.
 */

/**
 * Statuses that keep an org's TIER / paid-feature access alive, INCLUDING the
 * `past_due` payment-retry grace period (so a transient card failure doesn't instantly
 * yank private-repo access mid-cycle).
 */
const TIER_ACTIVE = new Set(["active", "trialing", "past_due"]);

/**
 * Stricter set for MANAGED-MODEL entitlement (the unbounded-Bedrock-spend gate).
 * `past_due` is EXCLUDED — a failed-payment org must stop minting `tmpx_` tokens and
 * accruing managed model cost it may never pay, even though its tier survives the grace
 * period. When the subscription recovers (`past_due → active`) the next webhook restores
 * `payg` automatically.
 */
const MANAGED_ACTIVE = new Set(["active", "trialing"]);

/** Does this subscription status keep the org's tier / paid-feature access? */
export function keepsTier(status: string): boolean {
  return TIER_ACTIVE.has(status);
}

/** Does this subscription status grant managed-model (`payg`) entitlement? */
export function grantsManaged(status: string): boolean {
  return MANAGED_ACTIVE.has(status);
}

export type DowngradeSchedule = {
  /** the subscription is set to cancel at period end (downgrade to OSS scheduled). */
  cancelAtPeriodEnd: boolean;
  /** when the scheduled downgrade takes effect (ISO), or null if none is scheduled. */
  planEndsAtIso: string | null;
};

/**
 * A downgrade-to-OSS scheduled in the portal leaves the subscription active until
 * period end (`cancel_at_period_end`); Stripe stamps `cancel_at` with the period-end
 * timestamp when the cancellation is scheduled. The ONE interpretation of that pair —
 * the billing read model must not re-derive it.
 */
export function downgradeSchedule(sub: {
  cancel_at_period_end: boolean;
  cancel_at: number | null;
}): DowngradeSchedule {
  if (sub.cancel_at_period_end && sub.cancel_at) {
    return { cancelAtPeriodEnd: true, planEndsAtIso: new Date(sub.cancel_at * 1000).toISOString() };
  }
  return { cancelAtPeriodEnd: false, planEndsAtIso: null };
}
