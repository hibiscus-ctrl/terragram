/**
 * The pure entitlement rules that map a Stripe subscription to a Terragram tier,
 * keyed on the stable price `lookup_key`s (not the generated price ids). The
 * webhook and quantity-sync read `lookup_key` straight off the subscription they
 * already hold, so there is nothing to resolve and no env id to manage. Live price
 * ids (needed only to BUILD a checkout) are resolved from the same lookup keys in
 * `stripe-catalog.ts`. Kept import-light so the node test runner can load it.
 */

import { STRIPE_LOOKUP_KEYS } from "@/config/pricing";

const TEAM_BASE_KEYS: readonly string[] = [
  STRIPE_LOOKUP_KEYS.teamMonthly,
  STRIPE_LOOKUP_KEYS.teamAnnual,
];

/** The banded Team base prices whose quantity tracks the billable repo count. */
export function isTeamBaseLookupKey(key: string | null | undefined): boolean {
  return key != null && TEAM_BASE_KEYS.includes(key);
}

const BASE_KEYS: readonly string[] = [
  STRIPE_LOOKUP_KEYS.teamMonthly,
  STRIPE_LOOKUP_KEYS.teamAnnual,
  STRIPE_LOOKUP_KEYS.payg,
];

/** The non-metered "base" line of a subscription — Team (banded) or PAYG (£0).
 *  This is the item a plan switch swaps in place; the metered managed-usage line
 *  always rides along unchanged. */
export function isBaseLookupKey(key: string | null | undefined): boolean {
  return key != null && BASE_KEYS.includes(key);
}

/**
 * Derive an org's crosswalk tier from the `lookup_key`s on its subscription. A
 * Team price grants `team`; anything else grants nothing — EXCEPT an existing
 * `enterprise` tier, which is set out-of-band by contract and must never be
 * clobbered by a self-serve subscription event.
 */
export function crosswalkTierFromLookupKeys(
  subscriptionLookupKeys: (string | null | undefined)[],
  currentTier: string | null,
): "team" | "enterprise" | null {
  if ((currentTier ?? "").trim().toLowerCase() === "enterprise") return "enterprise";
  const hasTeam = subscriptionLookupKeys.some((key) => isTeamBaseLookupKey(key));
  return hasTeam ? "team" : null;
}
