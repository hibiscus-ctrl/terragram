import { USAGE_PRODUCT } from "@/features/billing/managed-meter";
import { logger } from "@/libs/log";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

const log = logger("data/usage");

/**
 * Dashboard data access for `usage_events` (managed-model spend). Part of the
 * `features/data/` family (see `repos.ts` for the rationale).
 */

/**
 * This cycle's usage totals per kind (the allowance window starts at `sinceIso`).
 * Aggregated DB-side (`usage_totals_since`) — a raw event read is silently capped
 * at 1000 rows by PostgREST, which would understate a busy org's Billing page.
 */
export async function getUsageTotalsSince(
  orgId: string,
  sinceIso: string,
): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdminClient.rpc("usage_totals_since", {
    p_org: orgId,
    p_since: sinceIso,
    p_product: USAGE_PRODUCT,
  });
  if (error) {
    log.warn("usage_totals_since failed", { orgId, err: error.message });
    return {};
  }
  const totals: Record<string, number> = {};
  for (const row of data ?? []) totals[row.kind] = row.total;
  return totals;
}
