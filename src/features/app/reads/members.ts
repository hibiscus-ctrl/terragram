// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { getCurrentMembership } from "@/features/account/controllers/get-or-create-org";
import {
  can,
  isPrivilegedRole,
  type OrgRole,
  ROLE_LABEL,
  type RoleLabel,
} from "@/features/account/controllers/permissions";
import { assignableRoles, leaveError } from "@/features/app/member-core";
import { resolveEntitlements } from "@/features/billing/entitlements";
import {
  getAuthUserSummaries,
  listMembershipRows,
  listMembershipRowsExcept,
  listPendingInvites,
  listUserProfiles,
} from "@/features/data/members";
import { listOrgsForUser } from "@/features/data/orgs";

/**
 * Read models for the Members page, the leave-organisation panel and the
 * ownership-transfer candidate pool. Emails and sign-in timestamps come from the
 * `users` mirror of auth.users, so the views hydrate membership rows through
 * `hydrateMembers`.
 */

/**
 * Resolve display name / email for membership rows. Names prefer the public
 * profile, then auth metadata, then the email local-part.
 */
async function hydrateMembers<T extends { user_id: string }>(memberRows: T[]) {
  const ids = memberRows.map((r) => r.user_id);
  const [profiles, authById] = await Promise.all([listUserProfiles(ids), getAuthUserSummaries(ids)]);
  const nameById = new Map(profiles.map((p) => [p.id, p.full_name]));

  return memberRows.map((m) => {
    const auth = authById.get(m.user_id);
    const email = auth?.email ?? "—";
    const name = nameById.get(m.user_id) || auth?.fullName || email.split("@")[0] || email;
    return { row: m, name, email, lastSignInAt: auth?.lastSignInAt ?? null };
  });
}

/** One row of the Members table. */
export type MemberView = {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  /** How they joined ("Invited by …"), or null when that predates the tracking. */
  joinedHow: string | null;
  lastSignInAt: string | null;
  isSelf: boolean;
};

/** One row of the pending-invitations table. */
export type PendingInviteView = {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: string | null;
  expiresAt: string;
  expired: boolean;
};

export type MembersView = {
  orgLabel: string;
  members: MemberView[];
  invites: PendingInviteView[];
  /** The roles an Admin may hand out on the org's current plan. */
  assignableRoles: OrgRole[];
};

/** `memberships.joined_via` as one line. Rows that predate the tracking say nothing
 *  rather than guess. */
function describeJoin(joinedVia: string | null | undefined, invitedBy: string | null | undefined) {
  switch (joinedVia) {
    case "created":
      return "Created the organisation";
    case "invite":
      return invitedBy ? `Invited by ${invitedBy}` : "Joined by invitation";
    case "scim":
      return "Added by your identity provider (SCIM)";
    default:
      return null;
  }
}

/** The Members page. `members.manage` callers only (the page is guarded); null
 *  otherwise, so a stray call can never list another org's people. */
export async function getMembersView(): Promise<MembersView | null> {
  const membership = await getCurrentMembership();
  if (!membership || !can(membership.role, "members.manage")) return null;
  const { org } = membership;

  const [rows, inviteRows] = await Promise.all([
    listMembershipRows(org.id),
    listPendingInvites(org.id),
  ]);
  const hydrated = await hydrateMembers(rows);
  const now = Date.now();

  return {
    orgLabel: org.github_login,
    members: hydrated.map(({ row, name, email, lastSignInAt }) => ({
      userId: row.user_id,
      name,
      email,
      role: row.role,
      joinedHow: describeJoin(row.joined_via, row.invited_by_email),
      lastSignInAt,
      isSelf: row.user_id === membership.userId,
    })),
    invites: inviteRows.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invited_by,
      expiresAt: inv.expires_at,
      expired: new Date(inv.expires_at).getTime() <= now,
    })),
    assignableRoles: assignableRoles(resolveEntitlements(org).capabilities.auditorRole),
  };
}

/** The caller's own membership, for the leave-organisation panel. `blockedBy` is
 *  why they may not leave (the last Admin), or null. `orgs` is every org they
 *  belong to: the panel offers the org switch too, because it is on the one page
 *  every role can open — a Maintainer cannot reach the dashboard's org menu. */
export type LeaveView = {
  orgId: string;
  orgLabel: string;
  role: RoleLabel;
  blockedBy: string | null;
  orgs: { id: string; name: string; role: OrgRole }[];
};

export async function getLeaveView(): Promise<LeaveView | null> {
  const membership = await getCurrentMembership();
  if (!membership) return null;
  const [adminCount, orgs] = await Promise.all([
    isPrivilegedRole(membership.role)
      ? listMembershipRows(membership.org.id).then(
          (rows) => rows.filter((r) => isPrivilegedRole(r.role)).length,
        )
      : 0,
    listOrgsForUser(membership.userId),
  ]);
  return {
    orgId: membership.org.id,
    orgLabel: membership.org.github_login,
    role: ROLE_LABEL[membership.role],
    blockedBy: leaveError({ role: membership.role, adminCount }),
    orgs: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role })),
  };
}

/** A member the org can be handed over to — another Admin. */
export type TransferCandidate = { userId: string; name: string; email: string; role: RoleLabel };

/**
 * The members eligible to receive the org: every OTHER Admin (the initiator leaves,
 * so the recipient must already be able to run it). `org.transfer` callers only —
 * returns an empty list otherwise, which the Settings UI renders as "no other Admin yet".
 */
export async function getTransferCandidates(): Promise<TransferCandidate[]> {
  const membership = await getCurrentMembership();
  if (!membership || !can(membership.role, "org.transfer")) return [];

  const rows = await listMembershipRowsExcept(membership.org.id, membership.userId);
  const hydrated = await hydrateMembers(rows.filter((r) => isPrivilegedRole(r.role)));
  return hydrated.map(({ row, name, email }) => ({
    userId: row.user_id,
    name,
    email,
    role: ROLE_LABEL[row.role],
  }));
}
