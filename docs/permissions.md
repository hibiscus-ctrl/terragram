# Permissions

What each org role may do in Terragram, and where that is enforced. The tables
between the `<!-- …:start -->` / `<!-- …:end -->` markers are pinned to the code by
`tests/permissions-doc.test.ts`: change a rule and this file in the same commit, or
the suite fails.

## Roles

Organisations, memberships and the `org_role` enum are shared with Infraweaver
Cloud (same Supabase project), so the roles are Infraweaver's: **Admin**,
**Maintainer**, **Auditor** and **Billing Manager**. There is **no org Owner** —
Admin is the top of an org and every Admin is an equal.

Terragram's workspace is **per-user**: every signed-in user has their own
workspaces, snapshots, evidence and Git connections, whatever their org role. The
org roles decide only the account dashboard (Billing, Members and Settings) and the org-level
server actions behind it.

## Capability matrix

The source of truth is `CAPABILITIES` in
`src/features/account/controllers/permissions.ts`. Every org page names one
(`guardPage(capability)`) and every org-scoped server action requires one
(`guardMemberAction({ require: allows(capability) })`).

<!-- capability-matrix:start -->
| Capability | What it covers | Admin | Maintainer | Auditor | Billing Manager |
| --- | --- | --- | --- | --- | --- |
| `org.settings` | Open Settings and its danger zone | ✓ |  |  |  |
| `org.transfer` | Hand the organisation to another Admin and leave it | ✓ |  |  |  |
| `org.delete` | Delete the organisation | ✓ |  |  |  |
| `members.manage` | Members: invite, revoke invites, change roles, remove members | ✓ |  |  |  |
| `billing.manage` | Billing: plan, prepaid credit, managed models, Stripe portal | ✓ |  |  | ✓ |
<!-- capability-matrix:end -->

Rules that are not a property of the role alone:

- **The last Admin.** An org always keeps an Admin. Every role change and removal
  (an Admin removing a member, a member leaving, a hand-over) goes through the
  `set_membership` database function, which refuses (`last_admin`) to remove or
  demote the last one under a per-org lock. The actions count Admins first so the
  refusal reads as a sentence; the function is what holds under concurrency.
- **Your own membership.** An Admin cannot change their own role or remove
  themselves from the Members page; leaving is its own action. Any role may leave
  (Workspace settings, Organisation), except the last Admin, who hands the org over
  or deletes it instead.
- **Which role an invite or a role change may grant.** Any org role, except that
  the read-only Auditor needs a plan that includes it (Team or Enterprise). The
  plan is read when the role is granted, not trusted from the browser.
- **Transfer.** The org can only be handed to a member who is already an Admin of
  it; the initiator's membership is then removed (last-Admin guarded), so the org
  is never left unmanaged.
- **Billing-only persona.** A Billing Manager sees Billing alone in the dashboard;
  any page it may not open sends it to Billing. Everyone else is sent to the
  workspace.
- **Invites.** Terragram sends no invitation email: inviting returns a single-use
  link (valid 14 days, only its hash stored) for the Admin to share, and
  re-inviting an address replaces its pending invite. The link page is public, so
  a signed-out visitor can see the org and role and sign in with the link as the
  place to return to — signing in or signing up, by password, GitHub, Google or
  SSO alike (a provider sign-in, or a sign-up confirmed by email, carries it in a
  short-lived httpOnly cookie, never in the redirect URL). Accepting an invite claims it before joining, so of two concurrent
  acceptances only one is given a membership. An invite whose role the org's
  current plan no longer includes (the Auditor role needs Team or Enterprise) is
  refused when redeemed and stays pending.
- **The active org.** A member of several orgs works in one at a time: the org
  menu (the dashboard sidebar, and Workspace settings for roles that cannot open
  the dashboard) stores the chosen org's id in an httpOnly cookie. It is a
  preference, never a grant — every request re-checks it against the caller's
  memberships, and an id they do not belong to (a stale cookie after leaving or
  being removed) falls back to their oldest membership. Accepting an invite makes
  the invite's org the active one. Every capability check runs against the role
  in the active org.
- **Auto-join at sign-in.** Pending invites and SCIM seats matching a verified
  email are joined automatically, except that a SAML account (whose email its
  org's IdP asserts) auto-joins only the org that owns its SSO provider.

## Pages

Each account-dashboard page calls `guardPage(capability)`; a member without it is
redirected to a page they can open (`page-guards-core.ts`). The sidebar lists only
the pages the caller's role may open, filtered through the same matrix (`can`) —
a Billing Manager sees Billing alone and never the Members entry.

<!-- page-capabilities:start -->
| Page | Capability |
| --- | --- |
| `settings` | `org.settings` |
| `billing` | `billing.manage` |
| `members` | `members.manage` |
| `manage-subscription` | `billing.manage` |
<!-- page-capabilities:end -->

`manage-subscription` is the Stripe portal route handler, not a page; it checks the
same capability as the Billing page.

## Server actions

Org-scoped server actions and the capability their guard requires:

<!-- action-capabilities:start -->
| Capability | Actions |
| --- | --- |
| `org.transfer` | `transferOwnership` |
| `org.delete` | `deleteOrganisation` |
| `members.manage` | `inviteMember`, `revokeInvite`, `changeMemberRole`, `removeMember` |
| `billing.manage` | `createOrgUpgradeCheckout`, `createCreditTopupCheckout`, `setManagedModelsOptOut` |
<!-- action-capabilities:end -->

Every other server action is not org-scoped — it acts for the signed-in user alone,
or before there is a membership:

<!-- unscoped-actions:start -->
| Module | Actions | Scope |
| --- | --- | --- |
| `src/app/(auth)/auth-actions.ts` | `signInWithPassword`, `signUpWithPassword`, `signInWithOAuth`, `signInWithSso`, `signOut` | Sign-in; no session yet |
| `src/features/app/active-org-actions.ts` | `switchActiveOrg` | The caller's own memberships: switches the dashboard only to an org they belong to |
| `src/features/app/member-actions.ts` | `leaveOrganisation`, `acceptInvite` | The caller's own membership: any role may leave (last-Admin guarded); accepting needs only a session and the invite link's token |
| `src/features/app/org-actions.ts` | `createOrganisation` | Any signed-in user; creates the membership it would be guarded by |
| `src/features/git/actions.ts` | `gitProviderStatusAction`, `startGitConnectAction`, `disconnectGitAction`, `listGitRepositoriesAction`, `openChangeAction` | The user's own Git connections |
| `src/features/workspace/actions.ts` | `createWorkspaceAction`, `saveWorkspaceAction`, `generateEvidenceAction`, `renameWorkspaceAction`, `updateWorkspaceAction`, `listSnapshotsAction`, `restoreSnapshotAction`, `saveSettingsAction`, `createShareLinkAction`, `listShareLinksAction`, `revokeShareLinkAction`, `listReceiptsAction` | The user's own workspaces |
<!-- unscoped-actions:end -->

## Audit trail

Privileged account actions write to the shared, append-only `audit_log`. The
catalogue is `AUDIT_EVENTS` in `src/features/platform/audit-events.ts`;
`recordAudit` accepts nothing else. Every row carries the acting account
(`actor_id`, `actor_email`) and an `actor_type` from the live constraint.

Deleting or handing over the organisation, every member change (invite, revoke,
role change, removal, leaving) and switching managed models do not take effect
when their audit row cannot be written. A delete or hand-over that fails after its
row was written records a `*_failed` row beside it; a member change records
`member.change_failed`.

**Seats.** The Team plan bills per member. Every membership change (a join by
invite link or at sign-in, a removal, leaving, a hand-over) sets the Team
subscription's seat quantity to the new member count, prorated, for an org on a
live Team subscription only; a free, PAYG-only or Enterprise org is never
touched. The sync runs after the change and never undoes it: a sync Stripe does
not confirm is recorded (`billing.seats_sync_failed`) and reconciled the next
time an Admin or Billing Manager opens Billing, or when Stripe reports the
subscription changed. Billing says so while the count is still out of sync.

Deleting an organisation removes its row first and only then cancels its Stripe
subscription, so a failed delete never leaves a live org unbilled. A cancellation
Stripe does not confirm does not undo the deletion: it is recorded
(`org.subscription_cancel_failed`) and the Admin is told to contact support.

<!-- audit-events:start -->
| Event | When |
| --- | --- |
| `org.create` | A person created an organisation |
| `org.delete` | An Admin deleted the organisation |
| `org.delete_failed` | An Admin's org delete failed; the org still exists |
| `org.subscription_cancel_failed` | An org was deleted but Stripe did not confirm cancelling its subscription |
| `org.transfer_ownership` | An Admin handed the organisation to another Admin and left it |
| `org.transfer_failed` | An Admin's hand-over failed; they are still a member |
| `member.join` | Someone joined the org through an invite (how: invite link / pending invite at sign-in; who invited them) |
| `member.invite` | An Admin invited someone by email (the role; who invited them) |
| `member.invite_revoke` | An Admin revoked a pending invite |
| `member.role_change` | An Admin changed a member's role (from, to) |
| `member.remove` | An Admin removed a member from the org |
| `member.leave` | A member left the org |
| `member.change_failed` | A recorded member change did not take effect (which change, and why); nothing changed |
| `managed_models.enable` | Managed models were switched on |
| `managed_models.disable` | Managed models were switched off |
| `billing.seats_sync` | The Team subscription's seat quantity was set to the member count, prorated (from, to; what prompted it) |
| `billing.seats_sync_failed` | A seat-quantity sync did not complete; the membership change stands and the next reconcile retries |
<!-- audit-events:end -->
