// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { OrgChip, OrgSwitcherItem, UserChip } from "@/components/app/app-shell";
import { resolveEntitlements, type ProductTier } from "@/features/billing/entitlements";
import { listOrgsForUser } from "@/features/data/orgs";

import { getAuthenticatedUser } from "./get-authenticated-user";
import { getCurrentMembership, type OrgRole } from "./get-or-create-org";

/**
 * Identity + capabilities for the dashboard shell, resolved once per request and
 * shared by both the tenant layout `(app)` and the operator layout `(super)` so
 * they render the SAME role-aware sidebar. Read-only (never provisions).
 */
export type AppIdentity = {
  orgChip?: OrgChip | undefined;
  userChip?: UserChip | undefined;
  /** Every org this user belongs to — the switcher's list. Empty when signed out. */
  orgs: OrgSwitcherItem[];
  /** The org this request resolved to (the active org) — ticked in the switcher. */
  activeOrgId: string | null;
  /** The role in the active org — the shell filters its nav by its capabilities. */
  role: OrgRole | null;
  /** The org's resolved product tier. */
  tier: ProductTier;
};

const TIER_LABEL: Record<ProductTier, string> = {
  free: "Free plan",
  team: "Team",
  enterprise: "Enterprise",
};

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0))
      .join("")
      .toUpperCase() || "?"
  );
}

export async function getAppIdentity(): Promise<AppIdentity> {
  const [user, membership] = await Promise.all([getAuthenticatedUser(), getCurrentMembership()]);
  const orgs = user ? await listOrgsForUser(user.id) : [];
  const org = membership?.org ?? null;
  const role = membership?.role ?? null;
  const entitlements = org ? resolveEntitlements(org) : null;
  const tier: ProductTier = entitlements?.tier ?? "free";

  const orgChip: OrgChip | undefined = org
    ? { name: org.github_login, plan: TIER_LABEL[tier] }
    : undefined;

  let userChip: UserChip | undefined;
  if (user) {
    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      (typeof metadata.full_name === "string" && metadata.full_name) ||
      user.email ||
      "Signed-in user";
    userChip = { name, subtitle: user.email ?? "", initials: initialsOf(name) };
  }

  return {
    orgChip,
    userChip,
    orgs,
    activeOrgId: org?.id ?? null,
    role,
    tier,
  };
}
