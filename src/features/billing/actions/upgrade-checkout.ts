// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type Stripe from "stripe";

import { stripeTaxEnabled } from "@/config/flags";
import type { PlanTier } from "@/config/pricing";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { guardMemberAction } from "@/features/account/controllers/action-guards";
import { allows } from "@/features/account/controllers/permissions";
import { countSeats } from "@/features/billing/seats";
import { isBaseLookupKey } from "@/features/billing/plan-prices";
import { liveSubscription } from "@/features/billing/stripe-billing";
import { basePriceId, meteredUsagePriceId } from "@/features/billing/stripe-catalog";
import { stripeAdmin } from "@/libs/stripe/stripe-admin";
import { SITE_URL } from "@/utils/site-url";

/**
 * Start — or change — an ORG-level paid plan.
 *
 * - `team` unlocks Terraform output, the review gate and signed evidence (banded per seat).
 * - `payg` is just managed-model metering (a £0 base + the metered line), so an OSS
 *   org can opt into managed models WITHOUT taking Team.
 *
 * If the org already has a LIVE subscription (a card is on file), the base line is
 * swapped IN PLACE — this is the OSS→PAYG→Team (or Team→PAYG) path, and it avoids
 * leaving two active subscriptions both billing. Otherwise we open Stripe Checkout
 * to collect the card. Either way the subscription carries
 * `metadata.terragram_org_id`, so the webhook's `setOrgPlanFromSubscription` flips
 * `orgs.plan` (→ `payg`) and `crosswalk_tier`. The metered managed line rides along
 * (bills £0 when unused). `billing.manage` only. `redirect()`s on success (never returns
 * then); only returns to the caller on a failure.
 */
export async function createOrgUpgradeCheckout(opts?: {
  tier?: PlanTier;
  interval?: "month" | "year";
}): Promise<{ ok: false; error: string }> {
  const tier = opts?.tier ?? "team";
  const interval = opts?.interval ?? "month";
  // Distinguishes the two flows for the post-redirect banner: a Team upgrade
  // unlocks private repos; a PAYG opt-in just enables managed models.
  const doneFlag = tier === "payg" ? "managed" : "team";
  const priceId = await basePriceId(tier, interval);
  if (!priceId) {
    return {
      ok: false,
      error: "Billing is not configured yet — run `npm run stripe:setup` to create the prices.",
    };
  }

  const user = await getAuthenticatedUser();
  if (!user?.email) return { ok: false, error: "Please sign in to upgrade." };

  const guard = await guardMemberAction({
    require: allows("billing.manage"),
    permissionError: "You do not have access to manage billing.",
    signedOutError: "Could not resolve your organisation. Please try again.",
    provision: true,
  });
  if (!guard.ok) return { ok: false, error: guard.error };

  const org = guard.membership.org;

  // Asking for Tax on an unactivated account errors the checkout, hence the flag.
  // Prepaid credit top-ups are deliberately NOT taxed here — they're taxed when
  // drawn down on the (taxed) subscription invoice.
  const taxEnabled = stripeTaxEnabled();

  // The Team base line is per-seat (graduated banding lives inside the Stripe
  // price); its quantity is the seat count, floored at 1 (Checkout and a
  // subscription item both require ≥1). PAYG carries a single £0 base unit.
  let baseQuantity = 1;
  if (tier === "team") {
    try {
      baseQuantity = Math.max(1, await countSeats(org.id));
    } catch {
      // Never open a Checkout with a guessed quantity — the charge would be wrong.
      return { ok: false, error: "Could not resolve your seat count. Please try again." };
    }
  }

  // Card already on file → switch the base line in place rather than starting a
  // second subscription (which would double-bill). The metered managed line stays.
  const live = await liveSubscription(org.stripe_subscription_id);
  if (live) {
    const baseItem = live.items.data.find((item) => isBaseLookupKey(item.price.lookup_key));
    await stripeAdmin.subscriptions.update(live.id, {
      items: [
        baseItem
          ? { id: baseItem.id, price: priceId, quantity: baseQuantity }
          : { price: priceId, quantity: baseQuantity },
      ],
      proration_behavior: "create_prorations",
      metadata: { terragram_org_id: org.id },
      ...(taxEnabled ? { automatic_tax: { enabled: true } } : {}),
    });
    // The subscription.updated webhook flips plan/crosswalk_tier; revalidate so the
    // billing page reflects the change on return.
    revalidatePath("/billing");
    redirect(`${SITE_URL}/billing?upgraded=${doneFlag}`);
  }

  // No live subscription — open Checkout to collect a card. PAYG carries no per-seat
  // quantity beyond its single £0 base; the metered managed line bills £0 unused.
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { price: priceId, quantity: baseQuantity },
  ];
  const usagePrice = await meteredUsagePriceId();
  if (usagePrice) lineItems.push({ price: usagePrice });

  const session = await stripeAdmin.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    // Reuse the org's Stripe customer when we have one; otherwise prefill the email.
    ...(org.stripe_customer_id
      ? { customer: org.stripe_customer_id }
      : user.email
        ? { customer_email: user.email }
        : {}),
    billing_address_collection: "required",
    allow_promotion_codes: true,
    subscription_data: { metadata: { terragram_org_id: org.id } },
    metadata: { terragram_org_id: org.id },
    success_url: `${SITE_URL}/billing?upgraded=${doneFlag}`,
    cancel_url: `${SITE_URL}/billing`,
    ...(taxEnabled
      ? {
          automatic_tax: { enabled: true },
          // collect a VAT id (B2B reverse-charge) and persist the checkout address
          // onto an existing customer so Tax can resolve their location on renewal.
          tax_id_collection: { enabled: true },
          ...(org.stripe_customer_id
            ? { customer_update: { address: "auto", name: "auto" } }
            : {}),
        }
      : {}),
  });

  if (!session.url) return { ok: false, error: "Could not start checkout. Please try again." };
  redirect(session.url);
}
