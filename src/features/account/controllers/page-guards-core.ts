// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type Capability, can, isBillingOnly, type OrgRole } from "./permissions.ts";

/**
 * Per-page RBAC, separated from Next's `redirect` and the Supabase session so the
 * rules themselves can be unit tested. `page-guards.ts` binds the session.
 *
 * The dashboard hides nav items a role can't use and gates every server action,
 * but pages are still reachable by direct URL — so the access rules must also live
 * on the route. Each account-dashboard page names the capability it needs (see
 * `CAPABILITIES` in `permissions.ts`); a refused member is sent to a page they CAN
 * open, so a redirect never bounces between two pages that both refuse them.
 */

/** Deny target for a signed-in user with no membership (a provisioning anomaly —
 *  the sign-in callback normally provisions; /login re-resolves it). */
const NO_MEMBERSHIP_REDIRECT = "/login";

/** Where a refused member lands: Billing for the billing-only persona, else the
 *  workspace, which every signed-in user can open. */
export function homeFor(role: OrgRole): string {
  return isBillingOnly(role) ? "/billing" : "/workspace";
}

/**
 * Where the guard sends the caller for a page that needs `capability`, or `null`
 * to let the page render. A null membership is DENIED, not ignored: a guard that
 * no-ops on its own precondition would let a signed-in user with no membership
 * reach the page.
 */
export function pageVerdict(
  membership: { role: OrgRole } | null,
  capability: Capability,
): string | null {
  if (!membership) return NO_MEMBERSHIP_REDIRECT;
  return can(membership.role, capability) ? null : homeFor(membership.role);
}
