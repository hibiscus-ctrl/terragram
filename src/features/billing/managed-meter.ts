/**
 * Shared constants + window helper for the managed-models money meter (Phase D).
 *
 * The metering DECISION — "read prior spend this cycle, apply the allowance, append
 * the full-cost ledger row + a metered-overage row" — now lives in the atomic
 * `record_managed_usage` SQL function (see `database.sql`). It moved out of TS
 * because the previous read-then-write here raced two concurrent `/api/proxy-usage`
 * reports (under-metering the overage) and had no idempotency (a retry double-billed)
 * — both can only be fixed at the persistence layer (a per-org advisory lock + a
 * unique index on the usage id).
 *
 * What stays in TS: the `kind` literals (shared with the SQL and the Stripe flush)
 * and the allowance window. The marked-up cost and the per-seat allowance are
 * computed in `model-cost.ts`; the overage formula the SQL mirrors is
 * `meterableOverPence` there (proved correct by `model-cost.test.ts`).
 */

export const MANAGED_LEDGER_KIND = "managed_cost";
export const MANAGED_METER_KIND = "managed_meter";
/** One row per `tmpx_` token minted, `quantity` = the budget it carried (pence).
 *  A reconciliation signal only: cost sums and the flush never read this kind. */
export const MANAGED_MINT_KIND = "managed_mint";

/**
 * Terragram's rows in the shared `usage_events`. Infraweaver writes the same
 * table through the same SQL functions and flushes its own rows to its own Stripe
 * meter, so every read, sum and flush here is scoped to this value and every
 * `record_managed_usage` call passes it. Left out, a flush would bill
 * Infraweaver's usage on this meter, and the allowance and cap would count both
 * products' spend. The functions default to `'infraweaver'`, so an omitted
 * `p_product` silently means the other app.
 */
export const USAGE_PRODUCT = "terragram";

/** Start of the current UTC month — the allowance window. (Aligning this exactly to
 *  each org's Stripe billing period is a refinement for when the proxy is live.) */
export function monthStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * The spend-cap decision — MIRRORS the `over_cap` expression in
 * `record_managed_usage` (`v_spend >= p_cap_pence`); keep the two in lockstep.
 * `>=` (not `>`) so a cap of 0 turns managed models off outright, and the cap
 * window is the same UTC month as the allowance. Used at token mint, where the
 * spend is the cycle ledger sum; the SQL reports the same signal for in-flight
 * calls whose tokens outlive the crossing.
 */
export function overManagedCap(spendPence: number, capPence: number): boolean {
  return spendPence >= capPence;
}
