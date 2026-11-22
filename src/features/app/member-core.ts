// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  ActionGuardFailure,
  ActionGuardResult,
  ActionRateLimitOptions,
  GuardMemberActionOptions,
} from "@/features/account/controllers/action-guards";
import type { OrgMembership } from "@/features/account/controllers/get-or-create-org";
import {
  allows,
  isPrivilegedRole,
  ORG_ROLES,
  type OrgRole,
} from "@/features/account/controllers/permissions";
import type { AcceptByTokenResult } from "@/features/app/invites";
import { resolveEntitlements } from "@/features/billing/entitlements";
import type { MembershipMutationResult } from "@/features/data/members";
import type { AuditEntry } from "@/features/platform/audit-events";

/**
 * The member-management actions' decisions: who may invite, which roles an Admin
 * may hand out on the org's plan, when a role change, a removal or leaving must be
 * refused, and that each change is audited BEFORE it is made and not made when its
 * audit row cannot be written. Behind injected collaborators so a test can drive
 * every refusal and the call ORDER with no Supabase and no session;
 * `member-actions.ts` binds the production adapters.
 *
 * The last-Admin invariant is checked twice on purpose. The count here gives the
 * person a sentence they can act on; `set_membership` re-checks it under a per-org
 * lock, which is what actually stops two concurrent demotions emptying the org.
 */

const PERMISSION_ERROR = "You need the Admin role to manage members.";
const SIGNED_OUT_ERROR = "Sign in to manage your organisation.";
const AUDIT_ERROR = "The audit record could not be written, so nothing was changed.";
const HOUR_MS = 60 * 60_000;

export type MemberActionResult = { ok: true } | { ok: false; error: string };

export type InviteMemberInput = { email: string; role: string };
/** `emailed` is whether the invite email actually went out; the link is returned
 *  either way, so the Admin can always share it themselves. */
export type InviteMemberResult =
  | { ok: true; inviteUrl: string; emailed: boolean }
  | { ok: false; error: string };

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  role: z.string().trim().max(32),
});
const idSchema = z.uuid();
const tokenSchema = z.string().trim().min(1).max(256);

// ---------------------------------------------------------------------------
// The rules, as pure functions.
// ---------------------------------------------------------------------------

/** The roles an Admin may hand out (by invite or role change) on this plan: every
 *  org role, except that the read-only Auditor needs a plan that includes it. */
export function assignableRoles(auditorEntitled: boolean): OrgRole[] {
  return ORG_ROLES.filter((role) => role !== "auditor" || auditorEntitled);
}

export const AUDITOR_PLAN_ERROR =
  "The read-only Auditor role is part of the Team plan. Upgrade to assign it.";

/** Why `role` cannot be handed out, or null when it can. */
export function roleGrantError(role: string, auditorEntitled: boolean): string | null {
  if (!(ORG_ROLES as readonly string[]).includes(role)) return "Unknown role.";
  if (role === "auditor" && !auditorEntitled) return AUDITOR_PLAN_ERROR;
  return null;
}

const LAST_ADMIN_ERROR = "This is the last Admin. Make someone else an Admin first.";

/** Why an Admin may not change this member's role, or null when they may. */
export function roleChangeError(input: {
  actorId: string;
  targetId: string;
  targetRole: OrgRole;
  nextRole: OrgRole;
  /** Admins in the org, the target included. */
  adminCount: number;
}): string | null {
  if (input.targetId === input.actorId) {
    return "You can't change your own role. Ask another Admin.";
  }
  if (isPrivilegedRole(input.targetRole) && !isPrivilegedRole(input.nextRole) && input.adminCount <= 1) {
    return LAST_ADMIN_ERROR;
  }
  return null;
}

/** Why an Admin may not remove this member, or null when they may. Leaving is its
 *  own action, so an Admin cannot remove themselves here. */
export function removalError(input: {
  actorId: string;
  targetId: string;
  targetRole: OrgRole;
  adminCount: number;
}): string | null {
  if (input.targetId === input.actorId) return "To leave the organisation, use Leave organisation.";
  if (isPrivilegedRole(input.targetRole) && input.adminCount <= 1) return LAST_ADMIN_ERROR;
  return null;
}

/** Why this member may not leave, or null when they may. Any role may leave; the
 *  last Admin may not, because the org would be left with nobody to run it. */
export function leaveError(input: { role: OrgRole; adminCount: number }): string | null {
  if (isPrivilegedRole(input.role) && input.adminCount <= 1) {
    return "You are the last Admin. Make another member an Admin, or hand the organisation over or delete it in Settings.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The actions.
// ---------------------------------------------------------------------------

export type MemberActionDeps = {
  guard: (opts: GuardMemberActionOptions) => Promise<ActionGuardResult>;
  rateLimit: (
    name: string,
    userId: string,
    opts: ActionRateLimitOptions,
  ) => Promise<{ ok: true } | ActionGuardFailure>;
  /** The caller's membership with no role requirement (for leaving). */
  getCurrentMembership: () => Promise<OrgMembership | null>;
  /** The signed-in caller's email, for the audit row and the invite. */
  currentUserEmail: () => Promise<string | null>;
  listMembershipRows: (orgId: string) => Promise<{ user_id: string; role: OrgRole }[]>;
  getAuthUserSummaries: (
    userIds: readonly string[],
  ) => Promise<Map<string, { email: string | null }>>;
  generateInviteToken: () => { token: string; hash: string; expiresAt: string };
  /** The absolute accept link for a raw invite token. */
  inviteUrlFor: (token: string) => string;
  /** Id for a new invite. Defaults to a random UUID. */
  newId?: () => string;
  getPendingInvite: (orgId: string, inviteId: string) => Promise<{ email: string } | null>;
  deletePendingInviteByEmail: (orgId: string, email: string) => Promise<void>;
  insertInvite: (row: {
    id: string;
    orgId: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    invitedBy: string | null;
    invitedByUserId: string;
    expiresAt: string;
  }) => Promise<boolean>;
  /** Best-effort invite email. `false` = not sent: email is not configured, or
   *  the send failed (the adapter logs which). */
  sendInviteEmail: (params: {
    to: string;
    inviteUrl: string;
    orgName: string;
    role: OrgRole;
    invitedBy: string | null;
  }) => Promise<boolean>;
  deletePendingInvite: (orgId: string, inviteId: string) => Promise<boolean>;
  getMembershipRole: (orgId: string, userId: string) => Promise<OrgRole | null>;
  updateMembershipRole: (
    orgId: string,
    userId: string,
    role: OrgRole,
  ) => Promise<MembershipMutationResult>;
  deleteMembership: (orgId: string, userId: string) => Promise<MembershipMutationResult>;
  acceptInviteByToken: (token: string) => Promise<AcceptByTokenResult>;
  /** Make this org the caller's active org (the active-org cookie). */
  setActiveOrg: (orgId: string) => Promise<void>;
  /** `false` = the row was not written. */
  recordAudit: (entry: AuditEntry) => Promise<boolean>;
  /** Push the org's new seat count to its subscription. Never throws: a failed
   *  sync is recorded and reconciled later, and never undoes the change. */
  syncSeats: (orgId: string, trigger: "member.remove" | "member.leave") => Promise<unknown>;
  revalidate: (path: string) => void;
};

export function makeMemberActions(deps: MemberActionDeps) {
  const newId = deps.newId ?? randomUUID;

  async function adminCount(orgId: string): Promise<number> {
    const rows = await deps.listMembershipRows(orgId);
    return rows.filter((m) => isPrivilegedRole(m.role)).length;
  }

  /** The current members' emails, lower-cased: the "already a member" set. */
  async function memberEmails(orgId: string): Promise<Set<string>> {
    const rows = await deps.listMembershipRows(orgId);
    const summaries = await deps.getAuthUserSummaries(rows.map((r) => r.user_id));
    const emails = new Set<string>();
    for (const s of summaries.values()) if (s.email) emails.add(s.email.toLowerCase());
    return emails;
  }

  /** Records that a change whose row was already written did not happen, so that
   *  row does not stand alone. Best-effort: the change itself has already failed. */
  async function recordFailure(base: AuditEntry, reason: string): Promise<void> {
    await deps.recordAudit({
      ...base,
      action: "member.change_failed",
      metadata: { attempted: base.action, reason },
    });
  }

  function refresh() {
    deps.revalidate("/members");
    // The transfer candidates on Settings are the org's other Admins.
    deps.revalidate("/settings");
  }

  /**
   * Invite someone by email, with a role the org's plan allows. Admin only,
   * rate-limited. Replaces any pending invite for the same address, so a re-invite
   * refreshes the token, role and expiry. Emails the accept link when email is
   * configured, and returns it either way so the Admin can share it. The invitee
   * also joins automatically when they sign in with that address, verified.
   */
  async function inviteMember(input: InviteMemberInput): Promise<InviteMemberResult> {
    const guard = await deps.guard({
      require: allows("members.manage"),
      permissionError: PERMISSION_ERROR,
      signedOutError: SIGNED_OUT_ERROR,
      // Generous: a team onboarding at once is dozens. The cap only stops a
      // runaway client or a hijacked session minting links in bulk.
      rateLimit: { name: "members:invite", limit: 200, windowMs: HOUR_MS, message: "Too many invites recently." },
    });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { membership } = guard;

    const parsed = inviteSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return { ok: false, error: field === "role" ? "Unknown role." : "Enter a valid email address." };
    }
    const { email } = parsed.data;

    const refusal = roleGrantError(
      parsed.data.role,
      resolveEntitlements(membership.org).capabilities.auditorRole,
    );
    if (refusal) return { ok: false, error: refusal };
    const role = parsed.data.role as OrgRole;

    const orgId = membership.org.id;
    if ((await memberEmails(orgId)).has(email)) {
      return { ok: false, error: "That person is already a member of this organisation." };
    }

    const inviteId = newId();
    const invitedBy = await deps.currentUserEmail();
    const entry: AuditEntry = {
      orgId,
      actorId: membership.userId,
      actorEmail: invitedBy,
      actorType: "member",
      action: "member.invite",
      targetType: "invite",
      targetId: inviteId,
      targetLabel: email,
      metadata: { role, invited_by_user_id: membership.userId, invited_by_email: invitedBy },
    };
    if (!(await deps.recordAudit(entry))) return { ok: false, error: AUDIT_ERROR };

    const { token, hash, expiresAt } = deps.generateInviteToken();
    await deps.deletePendingInviteByEmail(orgId, email);
    const inserted = await deps.insertInvite({
      id: inviteId,
      orgId,
      email,
      role,
      tokenHash: hash,
      invitedBy,
      invitedByUserId: membership.userId,
      expiresAt,
    });
    if (!inserted) {
      await recordFailure(entry, "insert_failed");
      return { ok: false, error: "Could not create the invite. Please try again." };
    }

    deps.revalidate("/members");
    const inviteUrl = deps.inviteUrlFor(token);
    // The invite exists from here on, so nothing about the email may undo or fail
    // it: a send that throws counts as not sent, and the Admin is told so. (The
    // production sender never throws; it logs its own failures.)
    const emailed = await deps
      .sendInviteEmail({
        to: email,
        inviteUrl,
        orgName: membership.org.name ?? membership.org.github_login,
        role,
        invitedBy,
      })
      .catch(() => false);
    return { ok: true, inviteUrl, emailed };
  }

  /** Revoke a pending invite of this org. Admin only. */
  async function revokeInvite(inviteId: string): Promise<MemberActionResult> {
    const guard = await deps.guard({
      require: allows("members.manage"),
      permissionError: PERMISSION_ERROR,
      signedOutError: SIGNED_OUT_ERROR,
      rateLimit: { name: "members:revoke", limit: 200, windowMs: HOUR_MS },
    });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { membership } = guard;

    const id = idSchema.safeParse(inviteId);
    const orgId = membership.org.id;
    const invite = id.success ? await deps.getPendingInvite(orgId, id.data) : null;
    if (!id.success || !invite) {
      return { ok: false, error: "That invite is no longer pending. Refresh the list." };
    }

    const entry: AuditEntry = {
      orgId,
      actorId: membership.userId,
      actorEmail: await deps.currentUserEmail(),
      actorType: "member",
      action: "member.invite_revoke",
      targetType: "invite",
      targetId: id.data,
      targetLabel: invite.email,
    };
    if (!(await deps.recordAudit(entry))) return { ok: false, error: AUDIT_ERROR };

    if (!(await deps.deletePendingInvite(orgId, id.data))) {
      // Accepted (or revoked) between the read and the delete.
      await recordFailure(entry, "not_pending");
      return { ok: false, error: "That invite is no longer pending. Refresh the list." };
    }

    deps.revalidate("/members");
    return { ok: true };
  }

  /** Change another member's role to one the plan allows. Admin only; never the
   *  caller's own role, and never demoting the last Admin. */
  async function changeMemberRole(input: { userId: string; role: string }): Promise<MemberActionResult> {
    const guard = await deps.guard({
      require: allows("members.manage"),
      permissionError: PERMISSION_ERROR,
      signedOutError: SIGNED_OUT_ERROR,
      rateLimit: { name: "members:role", limit: 60, windowMs: HOUR_MS },
    });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { membership } = guard;

    const id = idSchema.safeParse(input.userId);
    if (!id.success) return { ok: false, error: "Member not found." };
    const userId = id.data;

    const grant = roleGrantError(
      String(input.role),
      resolveEntitlements(membership.org).capabilities.auditorRole,
    );
    if (grant) return { ok: false, error: grant };
    const nextRole = input.role as OrgRole;

    const orgId = membership.org.id;
    const targetRole = await deps.getMembershipRole(orgId, userId);
    if (!targetRole) return { ok: false, error: "Member not found." };
    if (targetRole === nextRole) return { ok: true };

    const refusal = roleChangeError({
      actorId: membership.userId,
      targetId: userId,
      targetRole,
      nextRole,
      adminCount: await adminCount(orgId),
    });
    if (refusal) return { ok: false, error: refusal };

    const entry: AuditEntry = {
      orgId,
      actorId: membership.userId,
      actorEmail: await deps.currentUserEmail(),
      actorType: "member",
      action: "member.role_change",
      targetType: "member",
      targetId: userId,
      metadata: { from: targetRole, to: nextRole },
    };
    if (!(await deps.recordAudit(entry))) return { ok: false, error: AUDIT_ERROR };

    const updated = await deps.updateMembershipRole(orgId, userId, nextRole);
    if (updated !== "ok") {
      await recordFailure(entry, updated);
      return {
        ok: false,
        error:
          updated === "last_admin"
            ? LAST_ADMIN_ERROR
            : updated === "not_found"
              ? "Member not found."
              : "Could not update the role. Please try again.",
      };
    }

    refresh();
    return { ok: true };
  }

  /** Remove another member. Admin only; never the last Admin. */
  async function removeMember(userId: string): Promise<MemberActionResult> {
    const guard = await deps.guard({
      require: allows("members.manage"),
      permissionError: PERMISSION_ERROR,
      signedOutError: SIGNED_OUT_ERROR,
      rateLimit: { name: "members:remove", limit: 60, windowMs: HOUR_MS },
    });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { membership } = guard;

    const id = idSchema.safeParse(userId);
    const orgId = membership.org.id;
    const targetRole = id.success ? await deps.getMembershipRole(orgId, id.data) : null;
    // Already gone: removing is idempotent.
    if (!id.success || !targetRole) return { ok: true };

    const refusal = removalError({
      actorId: membership.userId,
      targetId: id.data,
      targetRole,
      adminCount: await adminCount(orgId),
    });
    if (refusal) return { ok: false, error: refusal };

    const entry: AuditEntry = {
      orgId,
      actorId: membership.userId,
      actorEmail: await deps.currentUserEmail(),
      actorType: "member",
      action: "member.remove",
      targetType: "member",
      targetId: id.data,
      metadata: { role: targetRole },
    };
    if (!(await deps.recordAudit(entry))) return { ok: false, error: AUDIT_ERROR };

    const removed = await deps.deleteMembership(orgId, id.data);
    if (removed !== "ok") {
      await recordFailure(entry, removed);
      return {
        ok: false,
        error:
          removed === "last_admin" ? LAST_ADMIN_ERROR : "Could not remove the member. Please try again.",
      };
    }

    await deps.syncSeats(orgId, "member.remove");
    refresh();
    return { ok: true };
  }

  /**
   * Leave the caller's organisation. Any role may, so this asks for a membership
   * and no capability; the last Admin may not, and is told how to hand the org
   * over instead. The caller's workspaces are their own and are untouched.
   */
  async function leaveOrganisation(): Promise<MemberActionResult> {
    const membership = await deps.getCurrentMembership();
    if (!membership) return { ok: false, error: SIGNED_OUT_ERROR };

    const limited = await deps.rateLimit("members:leave", membership.userId, {
      limit: 10,
      windowMs: HOUR_MS,
    });
    if (!limited.ok) return { ok: false, error: limited.error };

    const orgId = membership.org.id;
    const refusal = leaveError({ role: membership.role, adminCount: await adminCount(orgId) });
    if (refusal) return { ok: false, error: refusal };

    const entry: AuditEntry = {
      orgId,
      actorId: membership.userId,
      actorEmail: await deps.currentUserEmail(),
      actorType: "member",
      action: "member.leave",
      targetType: "member",
      targetId: membership.userId,
      metadata: { role: membership.role },
    };
    if (!(await deps.recordAudit(entry))) return { ok: false, error: AUDIT_ERROR };

    const left = await deps.deleteMembership(orgId, membership.userId);
    if (left !== "ok") {
      await recordFailure(entry, left);
      return {
        ok: false,
        error:
          left === "last_admin"
            ? "You are the last Admin, so you cannot leave."
            : "Could not leave the organisation. Please try again.",
      };
    }

    await deps.syncSeats(orgId, "member.leave");
    refresh();
    return { ok: true };
  }

  /** Accept the invite behind a raw link token, for the `/invite/[token]` page. No
   *  membership is required: the caller is joining. The org they joined (or already
   *  belonged to) becomes their active org, so the dashboard opens on it. */
  async function acceptInvite(token: string): Promise<AcceptByTokenResult> {
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success) return { status: "invalid" };
    const result = await deps.acceptInviteByToken(parsed.data);
    if (result.status === "joined" || result.status === "already-member") {
      await deps.setActiveOrg(result.orgId);
    }
    if (result.status === "joined") refresh();
    return result;
  }

  return {
    inviteMember,
    revokeInvite,
    changeMemberRole,
    removeMember,
    leaveOrganisation,
    acceptInvite,
  };
}
