// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { getCurrentOrg } from "@/features/account/controllers/get-or-create-org";
import { resolveEntitlements } from "@/features/billing/entitlements";
import { countSeats } from "@/features/billing/seats";
import {
  customerCreditPence,
  subscriptionDowngradeSchedule,
} from "@/features/billing/stripe-billing";
import { bandedTotalPence } from "@/config/pricing";

import { getUsageTotalsSince } from "@/features/data/usage";

/**
 * Read model for the Billing surface — the org's resolved plan/tier + this-cycle
 * managed-model spend. Stripe I/O goes through the `stripe-billing` facade; the
 * "what does this subscription mean" interpretation lives in `subscription-status.ts`.
 */

export type BillingView = {
  planLabel: string;
  /** on any paid plan (drives the ACTIVE badge / current-tier highlight). */
  planActive: boolean;
  /** whether the paid capabilities are unlocked — Team+ only (drives the upgrade prompt). */
  privateUnlocked: boolean;
  /** seats the Team charge and the managed allowance are scaled by. Personal
   *  accounts are one; the count is asked for rather than assumed so teams are a
   *  change in one place. */
  seats: number;
  /** the current marginal-banded Team charge for `seats`, in pence. */
  bandedChargePence: number;
  /** this cycle's marked-up managed-model spend (full cost), in pence. */
  managedCostPence: number;
  /** the billable portion above the allowance (what reaches the meter), in pence. */
  meteredCostPence: number;
  /** the org has an active paid subscription (`orgs.plan === 'payg'`) — managed models
   *  are *available* (the add-on rides any active sub). Distinct from enabled below. */
  hasActiveSub: boolean;
  /** managed models are actually ON — active sub AND not opted out. The proxy-token gate. */
  managedModelsEnabled: boolean;
  /** the org has a Stripe customer, so the self-serve billing portal is reachable. */
  hasBilling: boolean;
  /** prepaid credit available on the Stripe customer balance, in pence. */
  creditBalancePence: number;
  /** the subscription is set to cancel at period end (downgrade to OSS scheduled). */
  cancelAtPeriodEnd: boolean;
  /** when the scheduled downgrade takes effect (ISO), or null if none is scheduled. */
  planEndsAtIso: string | null;
  demo: boolean;
};

export async function getBillingView(): Promise<BillingView> {
  const org = await getCurrentOrg();
  if (!org)
    return {
      planLabel: "Free plan",
      planActive: false,
      privateUnlocked: false,
      seats: 1,
      bandedChargePence: 0,
      managedCostPence: 0,
      meteredCostPence: 0,
      hasActiveSub: false,
      managedModelsEnabled: false,
      hasBilling: false,
      creditBalancePence: 0,
      cancelAtPeriodEnd: false,
      planEndsAtIso: null,
      demo: false,
    };

  // Managed spend is summed over the current UTC month (the allowance window).
  const now = new Date();
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const [seats, usageTotals] = await Promise.all([
    countSeats(org.id),
    getUsageTotalsSince(org.id, cycleStart),
  ]);

  const sumKind = (kind: string) => usageTotals[kind] ?? 0;
  // Label by the RESOLVED tier (Free/Team/Enterprise). Managed models are a separate
  // metered add-on (orthogonal to the tier), surfaced in the Managed-models card.
  const ent = resolveEntitlements(org);
  const TIER_LABEL: Record<typeof ent.tier, string> = {
    free: "OSS",
    team: "Team",
    enterprise: "Enterprise",
  };

  // Prepaid credit + any scheduled downgrade-to-OSS (surfaced so the page can
  // explain why the plan still reads as active and when it actually ends). Both
  // reads are best-effort inside the billing facade; the interpretation lives in
  // the pure `subscription-status.ts`, never re-derived here.
  const [creditBalancePence, { cancelAtPeriodEnd, planEndsAtIso }] = await Promise.all([
    customerCreditPence(org.stripe_customer_id),
    subscriptionDowngradeSchedule(org.stripe_subscription_id),
  ]);

  return {
    planLabel: TIER_LABEL[ent.tier],
    planActive: ent.tier !== "free",
    privateUnlocked: ent.capabilities.privateRepos,
    seats,
    bandedChargePence: bandedTotalPence(seats, "month"),
    managedCostPence: sumKind("managed_cost"),
    meteredCostPence: sumKind("managed_meter"),
    hasActiveSub: org.plan === "payg",
    managedModelsEnabled: org.plan === "payg" && !org.managed_opt_out,
    hasBilling: Boolean(org.stripe_customer_id),
    creditBalancePence,
    cancelAtPeriodEnd,
    planEndsAtIso,
    demo: false,
  };
}
