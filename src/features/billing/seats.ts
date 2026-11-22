import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

/**
 * Seats — the unit Terragram charges by.
 *
 * The billing layer was inherited repo-shaped, and Terragram users have no repos, so
 * the billable count was permanently zero. That is not a cosmetic mismatch: the
 * managed-inference allowance is scaled by it, so every user sat on a zero allowance
 * and was billed overage from their first token while the pricing page promised an
 * included amount per seat.
 *
 * Accounts are personal today, so a seat count is one per account. It is a function
 * rather than the literal `1` so that introducing teams is a change here and nowhere
 * else — every caller already asks the question the right way round.
 */

/** Billable seats for an org: its members, at least one. Throws when the count
 *  cannot be read — the seat sync must not push a guessed quantity to Stripe. */
export async function readSeatCount(orgId: string): Promise<number> {
  const { count, error } = await supabaseAdminClient
    .from("memberships")
    .select("user_id", { count: "exact", head: true })
    .eq("org_id", orgId);
  if (error) throw new Error(`seat count failed: ${error.message}`);
  return Math.max(1, count ?? 1);
}

/** Billable seats for an org. Personal accounts are exactly one. */
export async function countSeats(orgId: string): Promise<number> {
  // A failed read must not become quantity 0: that would push a full prorated credit
  // to a paying customer and zero their allowance. One seat is the floor.
  return readSeatCount(orgId).catch(() => 1);
}
