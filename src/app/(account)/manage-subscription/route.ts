import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { getCurrentMembership } from "@/features/account/controllers/get-or-create-org";
import { can } from "@/features/account/controllers/permissions";
import { withRedirectErrors } from "@/features/api/route-errors";
import { createBillingPortalUrl } from "@/features/billing/stripe-billing";
import { SITE_URL } from "@/utils/site-url";

export const dynamic = "force-dynamic";

/**
 * Open the Stripe Customer Portal for the org — cancel the subscription (→ back to
 * OSS), swap the card, or download invoices. The portal can cancel billing, so it's
 * `billing.manage` only (the same gate as starting/changing a plan). Returns the user to
 * /billing afterwards. Config (which actions the portal offers) is converged by
 * `scripts/stripe-setup.mjs`.
 */
async function handleGet() {
  // Billing is ORG-level: the Stripe customer lives on `orgs.stripe_customer_id`
  // (written by the subscription webhook), not on a per-user `customers` table.
  const membership = await getCurrentMembership();
  if (!membership) {
    return NextResponse.redirect(`${SITE_URL}/login`);
  }
  if (!can(membership.role, "billing.manage")) {
    // A member without billing access must not reach the portal (it can cancel the subscription).
    return NextResponse.redirect(`${SITE_URL}/billing`);
  }
  if (!membership.org.stripe_customer_id) {
    // No customer yet — the org never started a checkout. Send them to billing
    // to start a plan rather than 500-ing on a missing Stripe customer.
    return NextResponse.redirect(`${SITE_URL}/billing`);
  }

  const url = await createBillingPortalUrl(
    membership.org.stripe_customer_id,
    `${SITE_URL}/billing`,
  );

  redirect(url);
}

export const GET = withRedirectErrors(`${SITE_URL}/billing`)(handleGet);
