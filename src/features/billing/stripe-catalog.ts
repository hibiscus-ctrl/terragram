import { STRIPE_LOOKUP_KEYS, type PlanTier } from "@/config/pricing";
import { stripeAdmin } from "@/libs/stripe/stripe-admin";

/**
 * Resolve live Stripe price ids from their stable `lookup_key`s, so a deploy never
 * has to carry a `STRIPE_*_PRICE_ID` env var. Used only to BUILD a checkout (the
 * webhook matches on lookup_key directly). An explicit env id still wins as an
 * override — handy for pinning a specific price in an emergency. Cached per process
 * (price ids only change when `stripe:setup` transfers a lookup key, picked up on
 * the next restart).
 */

const priceIdCache = new Map<string, string>();

async function resolvePriceId(lookupKey: string, override?: string): Promise<string | undefined> {
  const pinned = override?.trim();
  if (pinned) return pinned;

  const cached = priceIdCache.get(lookupKey);
  if (cached) return cached;

  const price = (
    await stripeAdmin.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
  ).data[0];
  if (!price) return undefined;

  priceIdCache.set(lookupKey, price.id);
  return price.id;
}

/** The base (flat/banded) price id for a tier+interval. */
export async function basePriceId(
  tier: PlanTier,
  interval: "month" | "year",
): Promise<string | undefined> {
  if (tier === "payg")
    return resolvePriceId(STRIPE_LOOKUP_KEYS.payg, process.env.STRIPE_PAYG_PRICE_ID);
  return interval === "year"
    ? resolvePriceId(STRIPE_LOOKUP_KEYS.teamAnnual, process.env.STRIPE_TEAM_ANNUAL_PRICE_ID)
    : resolvePriceId(STRIPE_LOOKUP_KEYS.teamMonthly, process.env.STRIPE_TEAM_PRICE_ID);
}

/** The metered usage line to attach to a paid subscription: the managed-model money
 *  meter (1 unit = 1 penny of marked-up Bedrock cost). Bills £0 until usage flows. */
export async function meteredUsagePriceId(): Promise<string | undefined> {
  return resolvePriceId(STRIPE_LOOKUP_KEYS.managedCost, process.env.STRIPE_MANAGED_COST_PRICE_ID);
}
