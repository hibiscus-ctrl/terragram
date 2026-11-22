"use server";

import { redirect } from "next/navigation";

import { PRICING } from "@/config/pricing";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { guardMemberAction } from "@/features/account/controllers/action-guards";
import { allows } from "@/features/account/controllers/permissions";
import { normalizeTopupPence } from "@/features/billing/credit";
import { ensureOrgStripeCustomer } from "@/features/billing/stripe-billing";
import { stripeAdmin } from "@/libs/stripe/stripe-admin";
import { SITE_URL } from "@/utils/site-url";

/**
 * Buy prepaid credit. Opens a one-off Stripe Checkout (`mode: 'payment'`) for the
 * chosen amount; on payment the webhook adds it to the org's Stripe customer credit
 * balance, which Stripe then draws down against future invoices before charging the
 * card. `billing.manage` only. `redirect()`s to Stripe on success (never returns then);
 * only returns to the caller on a failure.
 */
export async function createCreditTopupCheckout(
  amountPence: number,
): Promise<{ ok: false; error: string }> {
  const pence = normalizeTopupPence(amountPence);
  if (pence === null) return { ok: false, error: "Choose a top-up amount between £5 and £10,000." };

  const user = await getAuthenticatedUser();
  if (!user?.email) return { ok: false, error: "Please sign in to add credit." };

  const guard = await guardMemberAction({
    require: allows("billing.manage"),
    permissionError: "You do not have access to manage billing.",
    signedOutError: "Could not resolve your organisation. Please try again.",
    provision: true,
  });
  if (!guard.ok) return { ok: false, error: guard.error };
  const org = guard.membership.org;

  // Credit lives on the customer balance, so the org needs a Stripe customer even
  // if it has never subscribed.
  const customerId = await ensureOrgStripeCustomer(org, user.email);

  const session = await stripeAdmin.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: PRICING.currency,
          product_data: { name: "Terragram prepaid credit" },
          unit_amount: pence,
        },
        quantity: 1,
      },
    ],
    billing_address_collection: "required",
    // Both the session and the payment intent carry the marker so the webhook can
    // recognise a top-up regardless of which object it inspects.
    payment_intent_data: { metadata: { terragram_org_id: org.id, purpose: "credit_topup" } },
    metadata: { terragram_org_id: org.id, purpose: "credit_topup" },
    success_url: `${SITE_URL}/billing?topup=success`,
    cancel_url: `${SITE_URL}/billing`,
  });

  if (!session.url) return { ok: false, error: "Could not start checkout. Please try again." };
  redirect(session.url);
}
