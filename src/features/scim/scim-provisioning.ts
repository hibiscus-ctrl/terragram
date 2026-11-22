import type { User } from "@supabase/supabase-js";

import { autoJoinScopeFor } from "@/features/account/controllers/auto-join";
import { deleteMembership } from "@/features/data/members";
import { escapeLikePattern } from "@/libs/supabase/like-pattern";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";
import type { Database } from "@/libs/supabase/types";

/**
 * Sign-in reconciliation of IdP-provisioned (SCIM) memberships. Terragram serves
 * no SCIM endpoint: `scim_users` rows are written by Infraweaver Cloud's SCIM API
 * for the orgs the two products share. A provisioned person may first sign in
 * here, so the sign-in path links their auth user to those records and grants
 * (active) or removes (inactive) the membership, exactly as Cloud's sign-in does.
 */

type OrgRole = Database["public"]["Enums"]["org_role"];

/** Role SCIM-provisioned users receive. Admin is deliberately NOT
 *  IdP-assignable (no group→role mapping); promote in-app. */
const SCIM_PROVISION_ROLE: OrgRole = "maintainer";

/** Add the user to the org as a SCIM-provisioned member, unless already a member
 *  (the PK upsert never changes an existing role — an Admin keeps theirs).
 *  Idempotent, and race-safe against a concurrent provision. */
async function ensureMembership(orgId: string, userId: string): Promise<void> {
  await supabaseAdminClient
    .from("memberships")
    .upsert(
      { org_id: orgId, user_id: userId, role: SCIM_PROVISION_ROLE, joined_via: "scim" },
      { onConflict: "org_id,user_id", ignoreDuplicates: true },
    );
}

/** Remove the user's org membership on deprovision — EXCEPT the last Admin, so an
 *  IdP deactivation can never orphan the org (lock everyone out of billing/admin).
 *  The `set_membership` RPC enforces the last-admin invariant atomically;
 *  'last_admin' / 'not_found' mean skip. */
async function removeMembership(orgId: string, userId: string): Promise<void> {
  await deleteMembership(orgId, userId);
}

/**
 * On sign-in, reconcile every SCIM record matching the user's email: link the auth
 * `user_id`, then grant (active) or remove (inactive) the org membership. Mirrors
 * `acceptPendingInvites` — best-effort, never throws on the happy path. No-op when
 * the user has no confirmed email.
 */
export async function reconcileScimMemberships(user: User): Promise<void> {
  const email = user.email?.toLowerCase();
  if (!email || !user.email_confirmed_at) return;
  // A SAML account's email is its org's IdP's assertion, so it reconciles only
  // into that org's SCIM records (see auto-join-core).
  const scope = await autoJoinScopeFor(user);
  if (!scope) return;

  let query = supabaseAdminClient
    .from("scim_users")
    .select("id, org_id, active, user_id")
    // For a non-SSO account this lookup is deliberately CROSS-ORG (a person may be
    // provisioned in several orgs), so no `org_id` filter contains a bad match —
    // which makes escaping load-bearing rather than merely tidy.
    .ilike("user_name", escapeLikePattern(email));
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  const { data: rows } = await query;

  for (const row of rows ?? []) {
    if (row.user_id !== user.id) {
      await supabaseAdminClient.from("scim_users").update({ user_id: user.id }).eq("id", row.id);
    }
    if (row.active) await ensureMembership(row.org_id, user.id);
    else await removeMembership(row.org_id, user.id);
  }
}
