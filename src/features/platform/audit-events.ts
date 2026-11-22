// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Json } from "@/libs/supabase/types";

/**
 * THE catalogue of audit events: every `audit_log.action` Terragram may write, and
 * what it means. `recordAudit` accepts only these names, so an event cannot be
 * emitted without being catalogued; `docs/permissions.md` renders this list and
 * `tests/permissions-doc.test.ts` holds the two together (and fails on an entry
 * nothing emits). `audit_log` is shared with Infraweaver Cloud, which writes its
 * own events to it — only Terragram's are listed here.
 *
 * Conventions for every entry written:
 *  - `actorType` says WHO acted (`AUDIT_ACTOR_TYPES`); `actorId`/`actorEmail`
 *    identify the account when a person acted.
 *  - `orgId` is the org it happened in (null for events about an org that no
 *    longer exists — the target keeps its id and label).
 *  - `metadata` carries what changed as flat scalars. Never a secret, a token, or
 *    a credential's value.
 */

/** The live `audit_log_actor_type_check` constraint's values. */
const AUDIT_ACTOR_TYPES = [
  "member", // a signed-in person acting in the dashboard
  "operator", // a Super Owner acting from Infraweaver's operator console
  "system", // the app itself (provisioning, housekeeping)
  "scim", // a customer's identity provider, through a SCIM token
  "github", // GitHub, through a signed App webhook
  "stripe", // Stripe, through a signed webhook
  "api_token", // CI or an integration, through an org API token
] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_EVENTS = {
  "org.create": "A person created an organisation",
  "org.delete": "An Admin deleted the organisation",
  "org.delete_failed": "An Admin's org delete failed; the org still exists",
  "org.subscription_cancel_failed":
    "An org was deleted but Stripe did not confirm cancelling its subscription",
  "org.transfer_ownership": "An Admin handed the organisation to another Admin and left it",
  "org.transfer_failed": "An Admin's hand-over failed; they are still a member",
  "member.join":
    "Someone joined the org through an invite (how: invite link / pending invite at sign-in; who invited them)",
  "member.invite": "An Admin invited someone by email (the role; who invited them)",
  "member.invite_revoke": "An Admin revoked a pending invite",
  "member.role_change": "An Admin changed a member's role (from, to)",
  "member.remove": "An Admin removed a member from the org",
  "member.leave": "A member left the org",
  "member.change_failed":
    "A recorded member change did not take effect (which change, and why); nothing changed",
  "managed_models.enable": "Managed models were switched on",
  "managed_models.disable": "Managed models were switched off",
  "billing.seats_sync":
    "The Team subscription's seat quantity was set to the member count, prorated (from, to; what prompted it)",
  "billing.seats_sync_failed":
    "A seat-quantity sync did not complete; the membership change stands and the next reconcile retries",
} as const satisfies Record<string, string>;

type AuditAction = keyof typeof AUDIT_EVENTS;

/** One `audit_log` row as the app writes it. */
export type AuditEntry = {
  orgId?: string | null | undefined;
  actorId?: string | null | undefined;
  actorEmail?: string | null | undefined;
  actorType: AuditActorType;
  action: AuditAction;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  targetLabel?: string | null | undefined;
  metadata?: Json | undefined;
};
