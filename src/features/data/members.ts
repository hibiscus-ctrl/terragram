import type { OrgRole } from "@/features/account/controllers/permissions";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

/**
 * Dashboard data access for `memberships` and the auth-admin user lookups. Part
 * of the `features/data/` family (see `repos.ts` for the rationale): org scoping
 * lives here, not at the call sites.
 */

export type MembershipRow = {
  user_id: string;
  role: OrgRole;
  /** How they joined, and who invited them. */
  joined_via?: string | null;
  invited_by_email?: string | null;
};

/**
 * Every membership of the org, oldest first. THROWS on a read error instead of
 * degrading to `[]`: the last-Admin checks count Admins from this list, and a
 * silently empty result reads as "no Admins left".
 */
export async function listMembershipRows(orgId: string): Promise<MembershipRow[]> {
  const { data, error } = await supabaseAdminClient
    .from("memberships")
    .select("user_id, role, created_at, joined_via, invited_by_email")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true })
    .order("user_id");
  if (error) throw new Error(`membership read failed: ${error.message}`);
  return data ?? [];
}

/** Every OTHER member of the org — the ownership-transfer candidate pool. */
export async function listMembershipRowsExcept(
  orgId: string,
  userId: string,
): Promise<MembershipRow[]> {
  const { data } = await supabaseAdminClient
    .from("memberships")
    .select("user_id, role, created_at")
    .eq("org_id", orgId)
    .neq("user_id", userId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

/** The user's membership — in a specific org when `orgId` is given, else their
 *  oldest (the single-org default; explicit ids keep this multi-org-ready). */
export async function getUserMembership(
  userId: string,
  orgId?: string,
): Promise<{ org_id: string; role: OrgRole } | null> {
  const base = supabaseAdminClient
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId);
  const { data } = await (orgId
    ? base.eq("org_id", orgId)
    : base.order("created_at", { ascending: true }).limit(1)
  ).maybeSingle();
  return data ?? null;
}

export async function getMembershipRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const { data } = await supabaseAdminClient
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return data?.role ?? null;
}

/** Outcome of a guarded membership mutation. `last_admin` is the DB-enforced
 *  invariant: the org must always keep at least one Admin. */
export type MembershipMutationResult = "ok" | "not_found" | "last_admin" | "error";

/** Change (`role`) or remove (`null`) a membership through the `set_membership`
 *  RPC — the count-and-mutate runs under a per-org advisory lock, so two concurrent
 *  removals or demotions can't race an app-side last-admin check into a zero-admin
 *  org. */
async function setMembership(
  orgId: string,
  userId: string,
  role: OrgRole | null,
): Promise<MembershipMutationResult> {
  const { data, error } = await supabaseAdminClient.rpc("set_membership", {
    p_org: orgId,
    p_user: userId,
    p_role: role,
  });
  if (error) return "error";
  return data === "ok" || data === "not_found" || data === "last_admin" ? data : "error";
}

export async function deleteMembership(
  orgId: string,
  userId: string,
): Promise<MembershipMutationResult> {
  return setMembership(orgId, userId, null);
}

export async function updateMembershipRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<MembershipMutationResult> {
  return setMembership(orgId, userId, role);
}

/** Public-profile display names for a set of member ids. */
export async function listUserProfiles(
  ids: string[],
): Promise<{ id: string; full_name: string | null }[]> {
  if (!ids.length) return [];
  const { data } = await supabaseAdminClient.from("users").select("id, full_name").in("id", ids);
  return data ?? [];
}

export type AuthUserSummary = {
  email: string | null;
  fullName: string | null;
  lastSignInAt: string | null;
};

const UNKNOWN_AUTH_USER: AuthUserSummary = { email: null, fullName: null, lastSignInAt: null };

/**
 * Email / name / last sign-in for many users in ONE query, from the `users` mirror
 * of auth.users (kept current by the shared schema's auth triggers) rather than an
 * Auth-admin call per member. Every requested id is in the map; one with no mirror
 * row (a deleted account) gets an empty summary. Throws on a read error: the invite
 * path dedups against these emails, and an empty set would let a duplicate through.
 */
export async function getAuthUserSummaries(
  userIds: readonly string[],
): Promise<Map<string, AuthUserSummary>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabaseAdminClient
    .from("users")
    .select("id, email, full_name, last_sign_in_at")
    .in("id", unique);
  if (error) throw new Error(`user summary read failed: ${error.message}`);
  const byId = new Map(
    (data ?? []).map((row) => [
      row.id,
      { email: row.email, fullName: row.full_name, lastSignInAt: row.last_sign_in_at },
    ]),
  );
  return new Map(unique.map((id) => [id, byId.get(id) ?? UNKNOWN_AUTH_USER]));
}

export type PendingInviteRow = {
  id: string;
  email: string;
  role: OrgRole;
  invited_by: string | null;
  expires_at: string;
  created_at: string;
};

/** The org's not-yet-accepted invites, newest first — expired ones included, so an
 *  Admin can see and revoke them. */
export async function listPendingInvites(orgId: string): Promise<PendingInviteRow[]> {
  const { data, error } = await supabaseAdminClient
    .from("org_invites")
    .select("id, email, role, invited_by, expires_at, created_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`invite read failed: ${error.message}`);
  return data ?? [];
}

/** A pending invite of THIS org (`null` when unknown, another org's, or accepted). */
export async function getPendingInvite(
  orgId: string,
  inviteId: string,
): Promise<{ email: string } | null> {
  const { data } = await supabaseAdminClient
    .from("org_invites")
    .select("email")
    .eq("id", inviteId)
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .maybeSingle();
  return data ?? null;
}

/** Drop any pending invite for this (org, email), so a re-invite refreshes the
 *  token, role and expiry instead of colliding on the unique index. */
export async function deletePendingInviteByEmail(orgId: string, email: string): Promise<void> {
  await supabaseAdminClient
    .from("org_invites")
    .delete()
    .eq("org_id", orgId)
    .eq("email", email)
    .is("accepted_at", null);
}

/** `false` when nothing was deleted (accepted meanwhile, another org's) or the
 *  delete failed. */
export async function deletePendingInvite(orgId: string, inviteId: string): Promise<boolean> {
  const { data, error } = await supabaseAdminClient
    .from("org_invites")
    .delete()
    .eq("id", inviteId)
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .select("id");
  return !error && (data ?? []).length > 0;
}

/** Insert an invite under a caller-chosen id (so its audit row can name it before
 *  it exists). Only the token's hash is stored. */
export async function insertInvite(row: {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  tokenHash: string;
  invitedBy: string | null;
  invitedByUserId: string;
  expiresAt: string;
}): Promise<boolean> {
  const { error } = await supabaseAdminClient.from("org_invites").insert({
    id: row.id,
    org_id: row.orgId,
    email: row.email,
    role: row.role,
    token_hash: row.tokenHash,
    invited_by: row.invitedBy,
    invited_by_user_id: row.invitedByUserId,
    expires_at: row.expiresAt,
  });
  return !error;
}
