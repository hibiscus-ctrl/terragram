// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { revalidatePath } from "next/cache";

import {
  actionRateLimit,
  guardMemberAction,
} from "@/features/account/controllers/action-guards";
import { setActiveOrgCookie } from "@/features/account/controllers/active-org";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { getCurrentMembership } from "@/features/account/controllers/get-or-create-org";
import { ROLE_LABEL } from "@/features/account/controllers/permissions";
import {
  type InviteMemberInput,
  type InviteMemberResult,
  makeMemberActions,
  type MemberActionDeps,
  type MemberActionResult,
} from "@/features/app/member-core";
import {
  type AcceptByTokenResult,
  acceptInviteByToken,
  generateInviteToken,
} from "@/features/app/invites";
import {
  deleteMembership,
  deletePendingInvite,
  deletePendingInviteByEmail,
  getAuthUserSummaries,
  getMembershipRole,
  getPendingInvite,
  insertInvite,
  listMembershipRows,
  updateMembershipRole,
} from "@/features/data/members";
import { syncOrgSeats } from "@/features/billing/seat-sync";
import { recordAudit } from "@/features/platform/super-owner";
import { sendTransactional } from "@/libs/ses/send-email";
import { siteUrl } from "@/utils/site-url";

export type { InviteMemberInput, InviteMemberResult, MemberActionResult };

/** Best-effort invite email through SES: `false` without an attempt when email
 *  is not configured, and `false` (logged) when the send fails. The template is
 *  imported lazily, out of this action's eager module graph. */
const sendInviteEmail: MemberActionDeps["sendInviteEmail"] = (params) =>
  sendTransactional({
    to: params.to,
    label: "invite",
    render: async () => {
      const { InviteEmail } = await import("@/features/emails/invite");
      return InviteEmail({
        inviteUrl: params.inviteUrl,
        orgName: params.orgName,
        role: ROLE_LABEL[params.role],
        invitedBy: params.invitedBy,
      });
    },
  });

// The decisions live in `member-core.ts`; this is the production binding. A
// `"use server"` module may only export async functions, hence the wrappers.
const actions = makeMemberActions({
  guard: guardMemberAction,
  rateLimit: actionRateLimit,
  getCurrentMembership: () => getCurrentMembership(),
  currentUserEmail: async () => (await getAuthenticatedUser())?.email ?? null,
  listMembershipRows,
  getAuthUserSummaries,
  generateInviteToken,
  inviteUrlFor: (token) => siteUrl(`/invite/${token}`),
  getPendingInvite,
  deletePendingInviteByEmail,
  insertInvite,
  sendInviteEmail,
  deletePendingInvite,
  getMembershipRole,
  updateMembershipRole,
  deleteMembership,
  acceptInviteByToken,
  setActiveOrg: setActiveOrgCookie,
  recordAudit,
  syncSeats: syncOrgSeats,
  revalidate: revalidatePath,
});

export async function inviteMember(input: InviteMemberInput): Promise<InviteMemberResult> {
  return actions.inviteMember(input);
}

export async function revokeInvite(inviteId: string): Promise<MemberActionResult> {
  return actions.revokeInvite(inviteId);
}

export async function changeMemberRole(input: {
  userId: string;
  role: string;
}): Promise<MemberActionResult> {
  return actions.changeMemberRole(input);
}

export async function removeMember(userId: string): Promise<MemberActionResult> {
  return actions.removeMember(userId);
}

export async function leaveOrganisation(): Promise<MemberActionResult> {
  return actions.leaveOrganisation();
}

export async function acceptInvite(token: string): Promise<AcceptByTokenResult> {
  return actions.acceptInvite(token);
}
