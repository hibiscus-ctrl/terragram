import { recordAudit } from "@/features/platform/super-owner";
import type { AuditActorType } from "@/features/platform/audit-events";
import { logger } from "@/libs/log";
import { stripeAdmin } from "@/libs/stripe/stripe-admin";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

import { planSeatSync, type SeatSubscription, seatSyncIdempotencyKey } from "./seat-sync-core";
import { readSeatCount } from "./seats";

const log = logger("billing/seat-sync");

/**
 * Push the org's seat count to its Team subscription, prorated. The decision is
 * `seat-sync-core.ts`; this fetches, applies and audits it.
 *
 * Called after every membership change (a join, a removal, leaving, a hand-over)
 * and as a reconcile (a billing-page view, the subscription webhook), so a sync
 * that failed earlier is retried by the next one. It NEVER throws: the membership
 * change that triggered it has already happened and must stand whatever Stripe
 * says. A sync that could not complete is recorded (`billing.seats_sync_failed`)
 * and reported to the caller, so the billing page can say the count is out of sync.
 */

/** What prompted the sync — recorded on its audit row. */
export type SeatSyncTrigger =
  | "member.join"
  | "member.remove"
  | "member.leave"
  | "org.transfer_ownership"
  | "billing_view"
  | "subscription_updated";

export type SeatSyncOutcome =
  /** Nothing to do (no seat-based subscription, or already equal). */
  | { status: "skipped" }
  /** Stripe now bills `seats`. */
  | { status: "synced"; seats: number; quantity: number | null }
  /** Stripe may not bill the current count. `seats`/`quantity` when they were read. */
  | { status: "failed"; seats: number | null; quantity: number | null };

function toSeatSubscription(sub: {
  id: string;
  status: string;
  items: { data: { id: string; quantity?: number | null; price: { lookup_key: string | null } }[] };
}): SeatSubscription {
  return {
    id: sub.id,
    status: sub.status,
    items: sub.items.data.map((item) => ({
      id: item.id,
      lookupKey: item.price.lookup_key,
      quantity: item.quantity ?? null,
    })),
  };
}

export async function syncOrgSeats(orgId: string, trigger: SeatSyncTrigger): Promise<SeatSyncOutcome> {
  // Stripe acted when the webhook asked; the app itself otherwise.
  const actorType: AuditActorType = trigger === "subscription_updated" ? "stripe" : "system";
  let seats: number | null = null;
  let quantity: number | null = null;
  let subscriptionId: string | null = null;
  // Where it failed, for the audit row. Never the error text: a provider error can
  // quote the request it failed on.
  let stage: "read" | "update" = "read";

  try {
    const { data: org, error } = await supabaseAdminClient
      .from("orgs")
      .select("stripe_subscription_id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(`org read failed: ${error.message}`);
    subscriptionId = org?.stripe_subscription_id ?? null;
    // Free/OSS: no subscription, no Stripe call at all.
    if (!subscriptionId) return { status: "skipped" };

    const [subscription, count] = await Promise.all([
      stripeAdmin.subscriptions.retrieve(subscriptionId),
      readSeatCount(orgId),
    ]);
    seats = count;
    const plan = planSeatSync({
      orgSubscriptionId: subscriptionId,
      subscription: toSeatSubscription(subscription),
      seats: count,
    });
    quantity = plan.quantity;
    if (plan.action === "skip") return { status: "skipped" };

    stage = "update";
    await stripeAdmin.subscriptions.update(
      subscriptionId,
      {
        items: [{ id: plan.itemId, quantity: plan.seats }],
        proration_behavior: "create_prorations",
      },
      { idempotencyKey: seatSyncIdempotencyKey(orgId, plan.quantity, plan.seats, new Date()) },
    );

    await recordAudit({
      orgId,
      actorType,
      action: "billing.seats_sync",
      targetType: "subscription",
      targetId: subscriptionId,
      metadata: { from: plan.quantity, to: plan.seats, trigger },
    });
    return { status: "synced", seats: plan.seats, quantity: plan.quantity };
  } catch (err) {
    log.error("seat sync failed", { orgId, trigger, err });
    await recordAudit({
      orgId,
      actorType,
      action: "billing.seats_sync_failed",
      targetType: "subscription",
      targetId: subscriptionId,
      metadata: {
        trigger,
        seats,
        stripe_quantity: quantity,
        stage,
        // Stripe's error class (e.g. `StripeConnectionError`), when it was Stripe.
        error_type: typeof (err as { type?: unknown }).type === "string" ? (err as { type: string }).type : null,
      },
    }).catch(() => false);
    return { status: "failed", seats, quantity };
  }
}
