// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { MANAGED_COST_METER_EVENT } from "@/config/pricing";
import { logger } from "@/libs/log";
import { stripeAdmin } from "@/libs/stripe/stripe-admin";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

import { USAGE_PRODUCT } from "./managed-meter.ts";

const log = logger("billing/metering");

/**
 * PAYG usage metering.
 *
 * `usage_events` is the local source of truth (written by the Action routes); this
 * flushes the unreported backlog to a Stripe Billing Meter, marking each event so
 * it is reported exactly once. The Stripe meter's `event_name` aggregates these
 * into the metered subscription line. Driven by the `/api/jobs/flush-usage` cron,
 * the subscription-renewal webhook and billing-page views — kept idempotent.
 */

const METER_EVENT_NAME =
  process.env.STRIPE_COST_METER_EVENT_NAME?.trim() || MANAGED_COST_METER_EVENT;

/** The single usage `kind` this meter aggregates: the per-event billable overage
 *  in pence (the money meter). The flush MUST filter on it so the full-cost LEDGER
 *  rows (`managed_cost`) and any other kind are never re-billed, and on
 *  `USAGE_PRODUCT` so Infraweaver's rows in the shared table never reach this
 *  meter. Stripe enforces a positive integer value, and `managed_meter` rows are
 *  only written when > 0. */
const METERED_KIND = "managed_meter";

export async function flushUsageForOrg(
  orgId: string,
): Promise<{ reported: number; skipped: string | null }> {
  const { data: org } = await supabaseAdminClient
    .from("orgs")
    .select("id, stripe_customer_id")
    .eq("id", orgId)
    .maybeSingle();

  if (!org?.stripe_customer_id) return { reported: 0, skipped: "no_stripe_customer" };

  const { data: events } = await supabaseAdminClient
    .from("usage_events")
    .select("id, quantity")
    .eq("org_id", orgId)
    .eq("kind", METERED_KIND)
    .eq("product", USAGE_PRODUCT)
    .is("reported_at", null)
    .order("created_at", { ascending: true })
    .limit(500);

  if (!events?.length) return { reported: 0, skipped: null };

  let reported = 0;
  for (const event of events) {
    try {
      // `identifier` makes the call idempotent — re-running a flush never double-bills.
      await stripeAdmin.billing.meterEvents.create({
        event_name: METER_EVENT_NAME,
        identifier: event.id,
        payload: {
          stripe_customer_id: org.stripe_customer_id,
          value: String(event.quantity),
        },
      });
      await supabaseAdminClient
        .from("usage_events")
        .update({ reported_at: new Date().toISOString(), stripe_meter_event_id: event.id })
        .eq("id", event.id);
      reported++;
    } catch (error) {
      // Stop on first failure — the rest stay unreported and retry next flush.
      log.error("meter event flush failed", { eventId: event.id, err: error });
      break;
    }
  }

  return { reported, skipped: null };
}

/**
 * How long a viewed flush stays satisfied for one org.
 *
 * Per process, so a multi-instance deployment may flush more than once per window.
 * That is harmless — every report is keyed by the usage row's id, so a repeat
 * reports nothing — and a shared lock would be a table and a round trip to save an
 * API call that mostly finds an empty backlog.
 */
const VIEW_FLUSH_INTERVAL_MS = 5 * 60_000;
const lastViewFlush = new Map<string, number>();

/**
 * Flush on a billing-page view, at most once per org per window.
 *
 * The scheduled flush (`/api/jobs/flush-usage`) runs every 15 minutes, so this
 * closes a gap of minutes, not of a billing period: an org looking at its bill
 * gets its newest usage in front of Stripe now rather than at the next tick. It
 * is also the only flush between renewals on a deployment whose cron is not set
 * up yet.
 *
 * **This does not change what the page shows.** The figures come from
 * `usage_events` directly (`usage_totals_since` does not filter on
 * `reported_at`), so they are current with or without this. What moves is what
 * STRIPE knows, and therefore when the usage lands on an invoice.
 *
 * Never throws: a metering problem must not take down the page that explains the
 * bill. A failure leaves the backlog for the next flush, which is the same place
 * every other failure mode leaves it.
 */
export async function flushUsageOnView(orgId: string): Promise<void> {
  const now = Date.now();
  const last = lastViewFlush.get(orgId) ?? 0;
  if (now - last < VIEW_FLUSH_INTERVAL_MS) return;
  lastViewFlush.set(orgId, now);
  try {
    await flushUsageForOrg(orgId);
  } catch (error) {
    log.error("billing view flush failed", { orgId, err: error });
  }
}

/**
 * Flush EVERY org that has unreported metered usage — the periodic-scheduler entry
 * point, driven by `POST /api/jobs/flush-usage` every 15 minutes. Driving the flush
 * on an interval (not only on the `subscription.updated` renewal webhook) keeps
 * managed usage metered WITHIN its billing period instead of landing a cycle in
 * arrears. Idempotent end to end: each `managed_meter` row reports exactly once
 * (identifier = row id), so overlapping or repeated runs never double-bill. Errors
 * per org are swallowed by `flushUsageForOrg` (it stops at the first failure and
 * leaves the rest for the next tick).
 */
export async function flushAllPendingUsage(): Promise<{ orgs: number; reported: number }> {
  const { data } = await supabaseAdminClient
    .from("usage_events")
    .select("org_id")
    .eq("kind", METERED_KIND)
    .eq("product", USAGE_PRODUCT)
    .is("reported_at", null);

  const orgIds = Array.from(new Set((data ?? []).map((e) => e.org_id)));
  let reported = 0;
  for (const orgId of orgIds) {
    const result = await flushUsageForOrg(orgId);
    reported += result.reported;
  }
  return { orgs: orgIds.length, reported };
}
