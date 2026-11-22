// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes } from "node:crypto";

import type { User } from "@supabase/supabase-js";

import { autoJoinScopeFor } from "@/features/account/controllers/auto-join";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import {
  claimThenJoin,
  INVITE_ROLE_UNAVAILABLE_ERROR,
  type InviteClaimDeps,
  type JoinLineage,
} from "@/features/app/invite-accept-core";
import { resolveEntitlements } from "@/features/billing/entitlements";
import { syncOrgSeats } from "@/features/billing/seat-sync";
import { setRepoGrants } from "@/features/data/repo-grants";
import { recordAudit } from "@/features/platform/super-owner";
import { logger } from "@/libs/log";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";
import type { Database } from "@/libs/supabase/types";

type OrgRole = Database["public"]["Enums"]["org_role"];

const log = logger("app/invites");

/**
 * Invite acceptance (plain server helpers — NOT server actions, so they can be
 * imported by the auth callback route and the `/invite/[token]` page).
 *
 * Two acceptance paths resolve an `org_invites` row into a `memberships` row:
 *   - {@link acceptPendingInvites}: email-match auto-join, run on every sign-in.
 *   - {@link acceptInviteByToken}: the tokenized invite link an Admin shares.
 *
 * Both claim the invite before joining (`invite-accept-core.ts`), so an invite is
 * single-use even under concurrent acceptance, and both refuse a role the org's
 * current plan no longer includes. Both are idempotent and never throw on the
 * happy path — a failure here must not block the user from landing in the app.
 */

const INVITE_TTL_DAYS = 14;
const DAY_MS = 86_400_000;

/** Mint an invite token. Only its sha256 is persisted (`token_hash`); the raw
 *  token travels once in the invite link, exactly like an `api_token`. */
export function generateInviteToken(): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(24).toString("base64url");
  return {
    token,
    hash: hashInviteToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS).toISOString(),
  };
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Add the user to an org with the invited role, unless they're already a member
 *  (the PK upsert keeps an existing membership's role — and its lineage —
 *  untouched). `null` = the write did not land, and the invite's claim must be
 *  released, or a transient insert failure spends the invite without granting
 *  anything. `repoIds` (non-empty) restricts the NEW membership to those repos —
 *  applied only alongside a fresh membership, never touching an existing member's
 *  grants. A new membership records who invited them. */
async function joinOrg(
  userId: string,
  orgId: string,
  role: OrgRole,
  repoIds: string[] | undefined,
  lineage: JoinLineage,
): Promise<{ created: boolean } | null> {
  const { error, data } = await supabaseAdminClient
    .from("memberships")
    .upsert(
      {
        org_id: orgId,
        user_id: userId,
        role,
        joined_via: "invite",
        invited_by: lineage.invitedBy,
        invited_by_email: lineage.invitedByEmail,
      },
      { onConflict: "org_id,user_id", ignoreDuplicates: true },
    )
    .select("user_id");
  if (error) {
    log.warn("membership upsert failed", { orgId, err: error });
    return null;
  }
  // `ignoreDuplicates` returns no row for an already-existing membership.
  const created = (data ?? []).length > 0;
  if (created && repoIds?.length) {
    await setRepoGrants(orgId, userId, repoIds);
  }
  return { created };
}

/** The claim/release pair {@link claimThenJoin} orders around `joinOrg`. */
const inviteClaimDeps: InviteClaimDeps<OrgRole> = {
  claimInvite: async (inviteId, userId, nowIso) => {
    const { data, error } = await supabaseAdminClient
      .from("org_invites")
      .update({ accepted_at: nowIso, accepted_by: userId })
      .eq("id", inviteId)
      .is("accepted_at", null)
      .gt("expires_at", nowIso)
      .select("id");
    if (error) throw new Error(`invite claim failed: ${error.message}`);
    return (data ?? []).length > 0;
  },
  releaseInvite: async (inviteId, userId) => {
    const { error } = await supabaseAdminClient
      .from("org_invites")
      .update({ accepted_at: null, accepted_by: null })
      .eq("id", inviteId)
      .eq("accepted_by", userId);
    if (error) log.warn("invite claim release failed", { inviteId, err: error });
  },
  joinOrg,
  recordAudit,
  auditorEntitled: async (orgId) => {
    const { data: org, error } = await supabaseAdminClient
      .from("orgs")
      .select("plan, crosswalk_tier")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(`invite org lookup failed: ${error.message}`);
    return org ? resolveEntitlements(org).capabilities.auditorRole : false;
  },
};

/**
 * Auto-accept every pending, unexpired invite whose email matches the signed-in
 * user's verified email. Called from sign-in provisioning with the full Auth user
 * (the render-path identity carries no `email_confirmed_at`) BEFORE personal-org
 * provisioning, so an invited user joins the inviter's org instead of getting
 * their own. No-op when the user has no email.
 */
export async function acceptPendingInvites(user: User): Promise<void> {
  const u = user;
  if (!u.email) return;
  // SECURITY: only auto-join on a *verified* email. This path matches purely on
  // the email address with no token possession, so trusting an unverified email
  // would let anyone who registers under a pending invitee's address silently
  // join that org with the invited role (account-takeover via signup). OAuth
  // identities (GitHub/Google) arrive already confirmed; email/password sign-ups
  // only reach here after confirmation.
  if (!u.email_confirmed_at) return;
  // SECURITY: a SAML account's "confirmed" email is whatever its org's IdP
  // asserted, so it auto-joins only that org's invites (see auto-join-core).
  const scope = await autoJoinScopeFor(u);
  if (!scope) return;
  const email = u.email.toLowerCase();
  const nowIso = new Date().toISOString();

  let query = supabaseAdminClient
    .from("org_invites")
    .select("id, org_id, role, repo_ids, invited_by, invited_by_user_id")
    .eq("email", email)
    .is("accepted_at", null)
    .gt("expires_at", nowIso);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  const { data: invites } = await query;

  for (const inv of invites ?? []) {
    // Claim, then join: a concurrent acceptance of the same invite cannot also
    // join. A failed join releases the claim, so the next sign-in retries it. An
    // invite whose role the org's plan no longer includes is skipped, not claimed
    // — it stays pending, and sign-in carries on.
    try {
      const outcome = await claimThenJoin(
        inviteClaimDeps,
        inv,
        { id: u.id, email },
        nowIso,
        "invite_on_sign_in",
      );
      if (outcome === "refused") {
        log.info("invite auto-accept skipped: role not on the org's plan", { inviteId: inv.id, role: inv.role });
      }
      if (outcome === "joined") await syncOrgSeats(inv.org_id, "member.join");
    } catch (error) {
      log.warn("invite auto-accept failed", { inviteId: inv.id, err: error });
    }
  }
}

export type InvitePreview =
  | { status: "valid"; orgLabel: string; role: OrgRole; invitedBy: string | null }
  | { status: "already-member"; orgLabel: string }
  | { status: "invalid" | "expired" | "accepted" };

/** Read-only lookup of an invite by its raw link token, for the accept page —
 *  resolves the org/role to display without mutating anything. With `viewerId`
 *  (the signed-in visitor), a link to an org they already belong to says so —
 *  including the link they were just auto-joined through at sign-in — instead of
 *  offering to spend it. */
export async function previewInvite(token: string, viewerId?: string | null): Promise<InvitePreview> {
  const { data: invite, error } = await supabaseAdminClient
    .from("org_invites")
    .select("org_id, role, invited_by, expires_at, accepted_at")
    .eq("token_hash", hashInviteToken(token))
    .maybeSingle();
  // A failed READ must not render "invalid" for a perfectly good invite — let the
  // page's error boundary show a retryable failure instead.
  if (error) throw new Error(`invite lookup failed: ${error.message}`);
  if (!invite) return { status: "invalid" };

  const { data: org } = await supabaseAdminClient
    .from("orgs")
    .select("github_login")
    .eq("id", invite.org_id)
    .maybeSingle();
  const orgLabel = org?.github_login ?? "the organisation";

  if (viewerId) {
    const { data: membership } = await supabaseAdminClient
      .from("memberships")
      .select("user_id")
      .eq("org_id", invite.org_id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (membership) return { status: "already-member", orgLabel };
  }
  if (invite.accepted_at) return { status: "accepted" };
  if (new Date(invite.expires_at).getTime() <= Date.now()) return { status: "expired" };

  return { status: "valid", orgLabel, role: invite.role, invitedBy: invite.invited_by };
}

export type AcceptByTokenResult =
  | { status: "joined" | "already-member"; orgLabel: string; orgId: string }
  | { status: "invalid" | "expired" | "signed-out" }
  | { status: "role-unavailable"; error: string };

/**
 * Accept the invite identified by a raw link token for the signed-in user.
 * Used by the `/invite/[token]` page. Distinguishes invalid/expired/signed-out
 * and a role the org's plan no longer includes, so the page can render the right
 * message.
 */
export async function acceptInviteByToken(token: string): Promise<AcceptByTokenResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { status: "signed-out" };

  const { data: invite, error } = await supabaseAdminClient
    .from("org_invites")
    .select("id, org_id, role, repo_ids, invited_by, invited_by_user_id, expires_at, accepted_at")
    .eq("token_hash", hashInviteToken(token))
    .maybeSingle();
  if (error) throw new Error(`invite lookup failed: ${error.message}`);
  if (!invite) return { status: "invalid" };

  const { data: org } = await supabaseAdminClient
    .from("orgs")
    .select("github_login")
    .eq("id", invite.org_id)
    .maybeSingle();
  const orgLabel = org?.github_login ?? "the organisation";

  // Already accepted: still fine if it was this user (idempotent), else treat as spent.
  const spent = async (): Promise<AcceptByTokenResult> => {
    const { data: membership } = await supabaseAdminClient
      .from("memberships")
      .select("user_id")
      .eq("org_id", invite.org_id)
      .eq("user_id", user.id)
      .maybeSingle();
    return membership
      ? { status: "already-member", orgLabel, orgId: invite.org_id }
      : { status: "invalid" };
  };
  if (invite.accepted_at) return spent();

  if (new Date(invite.expires_at).getTime() <= Date.now()) return { status: "expired" };

  // Claim, then join — only the caller whose claim flipped `accepted_at` gets a
  // membership. A failed join releases the claim, so a transient insert failure
  // does not consume the token while granting nothing.
  const outcome = await claimThenJoin(
    inviteClaimDeps,
    invite,
    { id: user.id, email: user.email ?? null },
    new Date().toISOString(),
    "invite_link",
  );
  if (outcome === "failed") {
    throw new Error("invite acceptance failed: membership write did not land");
  }
  if (outcome === "lost") return spent();
  if (outcome === "refused") return { status: "role-unavailable", error: INVITE_ROLE_UNAVAILABLE_ERROR };

  // The member is in; a seat sync that fails is recorded and reconciled later.
  await syncOrgSeats(invite.org_id, "member.join");
  return { status: "joined", orgLabel, orgId: invite.org_id };
}
