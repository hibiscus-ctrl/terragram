// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type Stripe from "stripe";

import { clientIp, rateLimited } from "@/features/api/rate-limit-route";
import { apiError, apiJson, readRawBody } from "@/features/api/responses";
import { withRouteErrors } from "@/features/api/route-errors";
import { flushUsageForOrg } from "@/features/billing/metering";
import { setOrgPlanFromSubscription } from "@/features/billing/org-plan";
import { syncOrgSeats } from "@/features/billing/seat-sync";
import { addPrepaidCredit, fetchSubscription } from "@/features/billing/stripe-billing";
import { constructStripeEvent } from "@/features/billing/stripe-webhook";
import { logger } from "@/libs/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("api/webhooks");

// Billing is ORG-LEVEL only (orgs.plan + usage_events). The starter template's
// per-user product/price/subscription sync was removed — Terragram never read
// those tables. We only react to subscription lifecycle + checkout to flip the
// org's plan (keyed off subscription.metadata.terragram_org_id).
const relevantEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

async function handlePost(req: Request) {
  // Per-IP flood guard, before buffering the body. Legitimate Stripe traffic is
  // well under this; a 429 just makes Stripe redeliver, so no event is lost.
  const limited = await rateLimited(`stripe-webhook:${clientIp(req)}`, {
    limit: 100,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const bodyResult = await readRawBody(req);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.raw;
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event: Stripe.Event;

  if (!sig || !webhookSecret) {
    return apiError(400, "Missing Stripe signature or webhook secret");
  }

  try {
    event = await constructStripeEvent(body, sig, webhookSecret);
  } catch (error) {
    log.warn("signature verification failed", { err: error });
    return apiError(400, "Invalid Stripe signature");
  }

  if (relevantEvents.has(event.type)) {
    try {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          // The switch narrows the payload type; verify the `object` discriminator
          // at runtime too before trusting fields (API-version drift insurance).
          const subscription: Stripe.Subscription = event.data.object;
          if (subscription.object !== "subscription") {
            log.warn("unexpected payload object", { eventType: event.type });
            break;
          }
          await setOrgPlanFromSubscription(subscription);
          if (
            event.type === "customer.subscription.updated" &&
            typeof subscription.metadata?.terragram_org_id === "string"
          ) {
            // Renewal is a natural point to push the metered backlog.
            await flushUsageForOrg(subscription.metadata.terragram_org_id);
            // And to reconcile the seat quantity: a sync that failed when a member
            // joined or left is retried here. It never throws (a failure is
            // recorded), and its own update raises one more event that finds the
            // count equal and stops.
            await syncOrgSeats(subscription.metadata.terragram_org_id, "subscription_updated");
          }
          break;
        }
        case "checkout.session.completed": {
          const session: Stripe.Checkout.Session = event.data.object;
          if (session.object !== "checkout.session") {
            log.warn("unexpected payload object", { eventType: event.type });
            break;
          }
          if (session.mode === "subscription" && typeof session.subscription === "string") {
            // Flip the org plan immediately rather than depend on the
            // subscription.created event ordering.
            const subscription = await fetchSubscription(session.subscription);
            await setOrgPlanFromSubscription(subscription);
          } else if (
            session.mode === "payment" &&
            session.metadata?.purpose === "credit_topup" &&
            session.payment_status === "paid" &&
            typeof session.customer === "string" &&
            typeof session.amount_total === "number" &&
            session.amount_total > 0
          ) {
            // Prepaid top-up: add the paid amount as customer credit (a negative
            // balance Stripe applies to future invoices). Idempotent on the session
            // id so a webhook redelivery can't double-credit.
            await addPrepaidCredit({
              customerId: session.customer,
              amountPence: session.amount_total,
              currency: session.currency ?? "gbp",
              orgId: session.metadata?.terragram_org_id ?? "",
              checkoutSessionId: session.id,
            });
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      log.error("handler failed", { eventType: event.type, eventId: event.id, err: error });
      return apiError(400, "Webhook handler failed");
    }
  }
  return apiJson({ received: true });
}

export const POST = withRouteErrors(handlePost);
