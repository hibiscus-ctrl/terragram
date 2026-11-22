// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Database } from "@/libs/supabase/types";

/**
 * The org roles. There is no org-level Owner: Admin is the top of an org, and every
 * Admin is an equal — any of them can hand the org over or delete it.
 */
export type OrgRole = Database["public"]["Enums"]["org_role"];

/** THE enum→display-label map. Every surface that renders a role reads this, so
 *  adding a role means adding one entry here (plus its badge tone in `roleMeta`). */
export const ROLE_LABEL = {
  admin: "Admin",
  maintainer: "Maintainer",
  auditor: "Auditor",
  billing_manager: "Billing Manager",
} as const satisfies Record<OrgRole, string>;

/** The display-label vocabulary (`"Admin" | "Maintainer" | ...`), derived from the map. */
export type RoleLabel = (typeof ROLE_LABEL)[OrgRole];

/** Every role, in display order. */
export const ORG_ROLES = Object.keys(ROLE_LABEL) as OrgRole[];

/**
 * THE role → capability matrix: the org RBAC model. Every org-scoped server action
 * and every org page names the capability it needs (`can` / `allows`), so what a
 * role may do is decided here and nowhere else — change a row and every guard that
 * names it moves with it. `docs/permissions.md` renders this table and
 * `tests/permissions-doc.test.ts` fails when the two disagree.
 *
 * Only what Terragram actually gates is here: the workspace is per-user (every
 * signed-in user has their own), so the org roles decide only the account
 * dashboard. The last-Admin invariant is not a capability — `set_membership`
 * enforces it in the database.
 */
export const CAPABILITIES = {
  "org.settings": {
    roles: ["admin"],
    label: "Open Settings and its danger zone",
  },
  "org.transfer": {
    roles: ["admin"],
    label: "Hand the organisation to another Admin and leave it",
  },
  "org.delete": {
    roles: ["admin"],
    label: "Delete the organisation",
  },
  "members.manage": {
    roles: ["admin"],
    label: "Members: invite, revoke invites, change roles, remove members",
  },
  "billing.manage": {
    roles: ["admin", "billing_manager"],
    label: "Billing: plan, prepaid credit, managed models, Stripe portal",
  },
} as const satisfies Record<string, { roles: readonly OrgRole[]; label: string }>;

export type Capability = keyof typeof CAPABILITIES;

/** Whether this role holds the capability. */
export function can(role: OrgRole, capability: Capability): boolean {
  return (CAPABILITIES[capability].roles as readonly OrgRole[]).includes(role);
}

/** The capability as a role predicate — the shape guards take (`require: allows(…)`). */
export function allows(capability: Capability): (role: OrgRole) => boolean {
  return (role) => can(role, capability);
}

/**
 * The Admin role itself, for the last-Admin invariant: an org must always keep a
 * member who can run it, so only an Admin can receive the org. Not a capability
 * check — ask `can` for those.
 */
export function isPrivilegedRole(role: OrgRole): boolean {
  return role === "admin";
}

/** The restricted billing-only persona: may reach the Billing page and nothing
 *  else in the account dashboard, so the sidebar shows it Billing alone and a
 *  refused page sends it there. */
export function isBillingOnly(role: OrgRole): boolean {
  return role === "billing_manager";
}
