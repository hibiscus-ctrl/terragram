import type Stripe from "stripe";

import { setOrgStripeCustomer } from "@/features/data/orgs";
import { stripeAdmin } from "@/libs/stripe/stripe-admin";

import { availableCreditPence } from "./credit";
import { downgradeSchedule, type DowngradeSchedule, keepsTier } from "./subscription-status";

/**
 * The billing facade — the Stripe I/O the surfaces OUTSIDE `features/billing/`
 * consume (the portal route, the webhook, the org-delete action, the billing read
 * model) plus the shared lifecycle lookups the billing actions reuse. Interpretation
 * of what a subscription MEANS stays in the pure `subscription-status.ts`; this
 * module just fetches and binds.
 */

/**
 * The org's current LIVE subscription, or null (cancelled / none → a checkout must
 * collect a card). "Live" = the same statuses that keep tier access (`keepsTier`),
 * including the `past_due` grace period — a card is on file, so a plan change can be
 * applied in place. Best-effort: a stale/cancelled id just falls through to null.
 */
export async function liveSubscription(
  subscriptionId: string | null,
): Promise<Stripe.Subscription | null> {
  if (!subscriptionId) return null;
  try {
    const sub = await stripeAdmin.subscriptions.retrieve(subscriptionId);
    return keepsTier(sub.status) ? sub : null;
  } catch {
    return null;
  }
}

/** Fetch a subscription, letting errors bubble — the webhook path wants a failure
 *  to 400 so Stripe redelivers the event. */
export async function fetchSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return stripeAdmin.subscriptions.retrieve(subscriptionId);
}

/** The org's scheduled downgrade, if any. Best-effort: if Stripe is unreachable the
 *  billing page shows "not scheduled" rather than failing. */
export async function subscriptionDowngradeSchedule(
  subscriptionId: string | null,
): Promise<DowngradeSchedule> {
  if (!subscriptionId) return { cancelAtPeriodEnd: false, planEndsAtIso: null };
  try {
    return downgradeSchedule(await stripeAdmin.subscriptions.retrieve(subscriptionId));
  } catch {
    return { cancelAtPeriodEnd: false, planEndsAtIso: null };
  }
}

/** Prepaid credit on the Stripe customer balance, in pence. Best-effort: if Stripe
 *  is unreachable we show £0 rather than failing the whole billing page. */
export async function customerCreditPence(customerId: string | null): Promise<number> {
  if (!customerId) return 0;
  try {
    const customer = await stripeAdmin.customers.retrieve(customerId);
    return "deleted" in customer ? 0 : availableCreditPence(customer.balance);
  } catch {
    return 0;
  }
}

/** Cancel the org's subscription so a deleted org stops billing. Best-effort: a
 *  Stripe hiccup must not block deleting the data, so it never throws — but it
 *  answers whether Stripe confirmed it, for callers that can tell someone. */
export async function cancelSubscriptionBestEffort(subscriptionId: string): Promise<boolean> {
  try {
    await stripeAdmin.subscriptions.cancel(subscriptionId);
    return true;
  } catch {
    // Stripe refuses to cancel a subscription that is already cancelled — the
    // common case for an org deleted after cancelling in the portal — and the org
    // keeps the id, so look before reporting a failure: already cancelled is the
    // outcome wanted.
    try {
      const subscription = await stripeAdmin.subscriptions.retrieve(subscriptionId);
      return subscription.status === "canceled";
    } catch (error) {
      return (error as { code?: unknown }).code === "resource_missing";
    }
  }
}

/** Open the Stripe Customer Portal (cancel, swap card, invoices) and return its URL. */
export async function createBillingPortalUrl(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const { url } = await stripeAdmin.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return url;
}

/**
 * The org's Stripe customer id, creating one (idempotent on the org id) and
 * persisting it when the org has never checked out — so a later subscription
 * reuses the same customer.
 */
export async function ensureOrgStripeCustomer(
  org: { id: string; stripe_customer_id: string | null },
  email: string,
): Promise<string> {
  if (org.stripe_customer_id) return org.stripe_customer_id;
  const customer = await stripeAdmin.customers.create(
    { email, metadata: { terragram_org_id: org.id } },
    { idempotencyKey: `customer_for_org_${org.id}` },
  );
  await setOrgStripeCustomer(org.id, customer.id);
  return customer.id;
}

/**
 * Add a paid top-up as customer credit (a negative balance Stripe applies to
 * future invoices). Idempotent on the checkout session id so a webhook redelivery
 * can't double-credit. Throws on failure (the webhook 400s → Stripe redelivers).
 */
export async function addPrepaidCredit(params: {
  customerId: string;
  amountPence: number;
  currency: string;
  orgId: string;
  checkoutSessionId: string;
}): Promise<void> {
  await stripeAdmin.customers.createBalanceTransaction(
    params.customerId,
    {
      amount: -params.amountPence,
      currency: params.currency,
      description: "Terragram prepaid credit top-up",
      metadata: {
        terragram_org_id: params.orgId,
        checkout_session: params.checkoutSessionId,
      },
    },
    { idempotencyKey: `credit_topup_${params.checkoutSessionId}` },
  );
}
