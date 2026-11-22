// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { logger } from "@/libs/log";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

import { managedEntitled } from "./managed-entitlement.ts";
import {
  MANAGED_LEDGER_KIND,
  MANAGED_MINT_KIND,
  monthStartIso,
  USAGE_PRODUCT,
} from "./managed-meter.ts";
import type { MintReconciliationRow } from "./managed-reconcile-core.ts";
import { countSeats } from "./seats.ts";
import { computeManagedCostPence, teamAllowancePence, type TokenUsage } from "./model-cost.ts";

const log = logger("billing/managed-usage");

/**
 * The Supabase entry point for the money meter, called by the `/api/proxy-usage`
 * callback. The marked-up cost (rate card) and the included allowance (seats) are
 * computed here in TS; the cycle-aware accumulation, the metered-overage
 * decision, and idempotency on `usageId` all happen atomically inside the
 * `record_managed_usage` SQL function — a per-org transaction advisory lock plus a
 * unique index on the usage id. That closes two revenue bugs the old read-then-write
 * here had: two concurrent reports double-spending the allowance and a proxy
 * retry double-billing.
 */

export type ManagedUsageResult = {
  /** Full marked-up cost of this usage, in pence (the stored cost if it was a retry). */
  costPence: number;
  /** Portion metered to Stripe this call (0 when under allowance or already recorded). */
  meteredPence: number;
  /** true when `usageId` was already recorded — the call was an idempotent no-op. */
  alreadyRecorded: boolean;
  /** false when the org lost managed entitlement after the token was minted —
   *  nothing was recorded or metered for this call. */
  entitled: boolean;
  /** true when the cycle spend, including this charge, has reached the org's cap
   *  (the same `overManagedCap` rule the mint enforces, evaluated by
   *  `record_managed_usage` under its lock). The charge is still recorded — the
   *  consumption already happened; this is the gateway's only signal to stop
   *  honouring the org's still-valid tokens. */
  overCap: boolean;
};

/**
 * Re-check managed entitlement at the metering boundary. The `tmpx_` token is
 * minted with a 1h TTL and re-verified at `/api/proxy-usage` only for HMAC + expiry +
 * scope — never for the live plan/opt-out state. So an org that downgrades (plan→none)
 * or opts out keeps billing for up to an hour. This re-derives the mint-time gate so we
 * stop billing the moment entitlement is lost. A missing org row reads as not-entitled.
 */
async function isManagedEntitled(orgId: string): Promise<boolean> {
  const { data, error } = await supabaseAdminClient
    .from("orgs")
    .select("plan, managed_opt_out")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(`managed entitlement lookup failed: ${error.message}`);
  if (!data) return false;
  return managedEntitled(data);
}

/**
 * Full managed spend this cycle (the `managed_cost` ledger, same UTC-month window
 * as the allowance), in pence. The mint-time half of the spend cap: the workspace
 * compares this against `orgs.managed_monthly_cap_pence` before issuing a token.
 * Throws on a read error — the caller fails CLOSED (refuses the mint) rather than
 * risking unbounded Bedrock spend on a blind read.
 */
export async function managedCycleSpendPence(
  orgId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const { data, error } = await supabaseAdminClient
    .from("usage_events")
    .select("quantity")
    .eq("org_id", orgId)
    .eq("kind", MANAGED_LEDGER_KIND)
    .eq("product", USAGE_PRODUCT)
    .gte("created_at", monthStartIso(nowMs));
  if (error) throw new Error(`managed cycle spend lookup failed: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + (row.quantity ?? 0), 0);
}

/** The org's managed spend ceiling for the cycle, in pence. A missing org row reads
 *  as a cap of 0 — managed models off — so an unknown org can never spend. */
export async function managedCapPence(orgId: string): Promise<number> {
  const { data, error } = await supabaseAdminClient
    .from("orgs")
    .select("managed_monthly_cap_pence")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(`managed cap lookup failed: ${error.message}`);
  return data?.managed_monthly_cap_pence ?? 0;
}

export async function recordManagedUsage(
  orgId: string,
  usage: TokenUsage,
  usageId: string,
  nowMs: number = Date.now(),
): Promise<ManagedUsageResult> {
  const costPence = computeManagedCostPence(usage);

  if (!(await isManagedEntitled(orgId))) {
    // The org lost entitlement after this run's token was minted. Don't accumulate or
    // meter — the real model call already happened (bounded by the token TTL), but we
    // don't bill a downgraded / opted-out org for it.
    return { costPence, meteredPence: 0, alreadyRecorded: false, entitled: false, overCap: false };
  }

  const [seats, capPence] = await Promise.all([countSeats(orgId), managedCapPence(orgId)]);
  const allowancePence = teamAllowancePence(seats);

  const { data, error } = await supabaseAdminClient.rpc("record_managed_usage", {
    p_org: orgId,
    p_usage_id: usageId,
    p_cost_pence: costPence,
    p_allowance_pence: allowancePence,
    p_since: monthStartIso(nowMs),
    p_cap_pence: capPence,
    p_product: USAGE_PRODUCT,
  });
  if (error) throw new Error(`record_managed_usage failed: ${error.message}`);

  const row = (data ?? {}) as {
    already_recorded?: boolean;
    cost_pence?: number;
    metered_pence?: number;
    over_cap?: boolean;
  };
  return {
    costPence: row.cost_pence ?? costPence,
    meteredPence: row.metered_pence ?? 0,
    alreadyRecorded: row.already_recorded ?? false,
    entitled: true,
    overCap: row.over_cap ?? false,
  };
}

/**
 * Append the mint ledger row for a `tmpx_` token just minted: `quantity` is the
 * budget it carried. The reconcile job counts these against `managed_cost` reports
 * (`reconcileManagedMints`). Best-effort and never rejects: the row is a
 * reconciliation hint, so a failed write is logged and must not fail the mint.
 */
export async function recordManagedMint(orgId: string, budgetPence: number): Promise<void> {
  try {
    const { error } = await supabaseAdminClient.from("usage_events").insert({
      org_id: orgId,
      kind: MANAGED_MINT_KIND,
      quantity: budgetPence,
      product: USAGE_PRODUCT,
    });
    if (error) log.warn("mint ledger write failed", { orgId, err: error.message });
  } catch (err) {
    log.warn("mint ledger write threw", { orgId, err });
  }
}

/**
 * The reconciliation read: per-org `managed_mint` vs `managed_cost` counts over
 * the window, aggregated DB-side so it is exact regardless of event volume.
 * Consumed by `/api/jobs/reconcile-managed`. Throws on a read error.
 */
export async function reconcileManagedMints(
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<MintReconciliationRow[]> {
  const { data, error } = await supabaseAdminClient.rpc("managed_mint_reconciliation", {
    p_since: new Date(nowMs - windowMs).toISOString(),
    p_product: USAGE_PRODUCT,
  });
  if (error) throw new Error(`managed mint reconciliation failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    orgId: row.org_id,
    mints: row.mints,
    usageReports: row.usage_reports,
  }));
}
