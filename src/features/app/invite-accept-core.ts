// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuditEntry } from "@/features/platform/audit-events";

/**
 * The ordering that makes accepting an invite single-use, behind injected
 * collaborators so it is testable without Supabase. `invites.ts` binds the
 * production adapters.
 *
 * CLAIM first, then join. The claim is a compare-and-set on `accepted_at IS
 * NULL`, so of two concurrent acceptances exactly one flips it — and only that
 * one is given a membership. Joining first and stamping `accepted_at`
 * unconditionally afterwards let both callers join on one invite.
 *
 * A membership an invite creates records who let the member in (the inviting
 * account, and its address as it was then), and the join is audited with the
 * same facts.
 */

export type InviteToClaim = {
  id: string;
  org_id: string;
  role: string;
  repo_ids?: string[] | null;
  /** The inviter's address as recorded on the invite. */
  invited_by?: string | null;
  /** The inviting account (null for invites that predate it, or once deleted). */
  invited_by_user_id?: string | null;
};

/** Who let a new member in. */
export type JoinLineage = { invitedBy: string | null; invitedByEmail: string | null };

/** How the invite was redeemed: its link, or automatically at sign-in by a
 *  verified address matching a pending invite. */
export type InviteRedemption = "invite_link" | "invite_on_sign_in";

export type InviteClaimDeps<Role extends string> = {
  /** Stamp the invite accepted by `userId` iff it is still unaccepted (and
   *  unexpired); true only for the caller whose update flipped it. Throws on a
   *  write error. */
  claimInvite: (inviteId: string, userId: string, nowIso: string) => Promise<boolean>;
  /** Undo this user's claim, so a failed join leaves the invite usable. */
  releaseInvite: (inviteId: string, userId: string) => Promise<void>;
  /** Add the membership. `created: false` = they were already a member (left
   *  untouched); `null` = the write did not land. */
  joinOrg: (
    userId: string,
    orgId: string,
    role: Role,
    repoIds: string[] | undefined,
    lineage: JoinLineage,
  ) => Promise<{ created: boolean } | null>;
  recordAudit: (entry: AuditEntry) => Promise<unknown>;
  /** Whether the org's CURRENT plan includes the Auditor role. Read at accept
   *  time, not trusted from when the invite was sent: an org can downgrade in
   *  between. Only consulted for an `auditor` invite. */
  auditorEntitled: (orgId: string) => Promise<boolean>;
};

/** Shown on the invite link when its role is no longer on the org's plan. */
export const INVITE_ROLE_UNAVAILABLE_ERROR =
  "This invitation is for the read-only Auditor role, which this organisation's plan no longer includes. Ask an org admin for a new invite.";

/**
 * `joined` — this caller claimed the invite and the membership landed.
 * `lost` — another caller claimed it first; nothing was granted here.
 * `failed` — the membership write did not land; the claim was released so the
 *  invite is not spent without granting anything.
 * `refused` — the invited role is not on the org's current plan; the invite was
 *  NOT claimed, so it stays pending and works again if the org re-upgrades.
 */
export type ClaimOutcome = "joined" | "lost" | "failed" | "refused";

export async function claimThenJoin<Role extends string>(
  deps: InviteClaimDeps<Role>,
  invite: InviteToClaim & { role: Role },
  user: { id: string; email: string | null },
  nowIso: string,
  via: InviteRedemption,
): Promise<ClaimOutcome> {
  // The plan gate, checked before the claim: an Auditor invite sent on the Team
  // plan must not grant the role after a downgrade, and refusing before the claim
  // leaves it unspent.
  if (invite.role === "auditor" && !(await deps.auditorEntitled(invite.org_id))) {
    return "refused";
  }
  if (!(await deps.claimInvite(invite.id, user.id, nowIso))) return "lost";
  const lineage: JoinLineage = {
    invitedBy: invite.invited_by_user_id ?? null,
    invitedByEmail: invite.invited_by ?? null,
  };
  const joined = await deps.joinOrg(
    user.id,
    invite.org_id,
    invite.role,
    invite.repo_ids ?? undefined,
    lineage,
  );
  if (!joined) {
    await deps.releaseInvite(invite.id, user.id);
    return "failed";
  }
  // An existing member redeeming an invite changes nothing, so there is no join.
  if (joined.created) {
    await deps.recordAudit({
      orgId: invite.org_id,
      actorId: user.id,
      actorEmail: user.email,
      actorType: "member",
      action: "member.join",
      targetType: "member",
      targetId: user.id,
      targetLabel: user.email,
      metadata: {
        via,
        invite_id: invite.id,
        role: invite.role,
        repo_grants: invite.repo_ids?.length ?? 0,
        invited_by_user_id: lineage.invitedBy,
        invited_by_email: lineage.invitedByEmail,
      },
    });
  }
  return "joined";
}
