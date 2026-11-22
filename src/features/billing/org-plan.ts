import type Stripe from "stripe";

import { crosswalkTierFromLookupKeys } from "@/features/billing/plan-prices";
import { grantsManaged, keepsTier } from "@/features/billing/subscription-status";
import { logger } from "@/libs/log";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";
import type { Database } from "@/libs/supabase/types";

type OrgPlan = Database["public"]["Enums"]["org_plan"];

const log = logger("billing/org-plan");

/**
 * Flip an org's `plan` and `crosswalk_tier` from a Stripe subscription event
 * (gating is server-side). Keyed off `subscription.metadata.terragram_org_id`,
 * which the org-level checkout sets; absent that, this is a no-op so the starter's
 * per-user subscription flow is unaffected. An active subscription grants `payg`
 * (managed models); a Team base price additionally grants the `team` crosswalk
 * tier, which is what unlocks private-repo Cloud. An out-of-band `enterprise` tier
 * is preserved.
 */
export async function setOrgPlanFromSubscription(subscription: Stripe.Subscription): Promise<void> {
  const orgId =
    typeof subscription.metadata?.terragram_org_id === "string"
      ? subscription.metadata.terragram_org_id
      : null;
  if (!orgId) return;

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  const { data: org } = await supabaseAdminClient
    .from("orgs")
    .select("stripe_customer_id, crosswalk_tier")
    .eq("id", orgId)
    .maybeSingle();
  if (org?.stripe_customer_id && org.stripe_customer_id !== customerId) {
    log.warn("refusing plan flip: subscription customer does not match the bound customer", {
      orgId,
      customerId,
      boundCustomerId: org.stripe_customer_id,
    });
    return;
  }

  // Tier/access and managed-model entitlement are decoupled. A `past_due` org
  // keeps its tier (grace period) but does NOT keep `payg` — so it stops minting
  // `tmpx_` tokens and accruing managed Bedrock spend it may never pay. The mint route
  // (`proxy-token`) and `managedEntitled` both gate on `plan==='payg'`, so this one
  // place closes the grace-period spend leak.
  const active = keepsTier(subscription.status);
  const plan: OrgPlan = grantsManaged(subscription.status) ? "payg" : "none";

  // Only a tier-active subscription grants a crosswalk tier; a cancelled/unpaid one
  // drops it (preserving an out-of-band enterprise tier). We read the stable
  // lookup_key off the subscription's own prices — no env ids, and a transient
  // Stripe error can never mis-map a price and silently downgrade an org.
  const lookupKeys = (subscription.items?.data ?? []).map((item) => item.price.lookup_key);
  const crosswalkTier = active
    ? crosswalkTierFromLookupKeys(lookupKeys, org?.crosswalk_tier ?? null)
    : crosswalkTierFromLookupKeys([], org?.crosswalk_tier ?? null);

  await supabaseAdminClient
    .from("orgs")
    .update({
      plan,
      crosswalk_tier: crosswalkTier,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: customerId,
    })
    .eq("id", orgId);
}
