import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { cache } from "react";

import {
  deleteOrgRow,
  getOrgById,
  getOrgBySlug,
  insertBootstrapMembership,
  insertOrg,
  listMembershipRefs,
  type OrgRow,
} from "@/features/data/orgs";
import { getMembershipRole, getUserMembership } from "@/features/data/members";

import { readActiveOrgCookie } from "./active-org";
import { resolveActiveOrgId } from "./active-org-core";
import { getAuthenticatedUser } from "./get-authenticated-user";
import type { OrgRole } from "./permissions";

/** The header the proxy stamps from a `/o/{slug}/...` URL (`proxy.ts` →
 *  `supabase-middleware-client.ts`) — the ambient seam that lets every existing
 *  `getCurrentOrg`/`getCurrentMembership()` call (including ones with no route
 *  params in scope, e.g. server actions and `features/app/reads/*`) resolve
 *  against the URL's org instead of the active-org cookie. */
const ACTIVE_ORG_HEADER = "x-active-org";

export type { OrgRole } from "./permissions";

type Org = OrgRow;

export type OrgMembership = { org: Org; role: OrgRole; userId: string };

/**
 * Resolve the org for the dashboard request.
 *
 * Identity here is Supabase Auth (the human/OAuth session); tenancy is the
 * `orgs`/`memberships` pair. The Action-facing API routes use
 * org *tokens* instead — both ultimately scope every query by `org_id`.
 *
 * `getCurrentOrg` is read-only (returns null when signed-out — the dashboard
 * then falls back to demo data so the surfaces stay previewable). `getOrCreateOrg`
 * provisions a personal org + owner membership on first authenticated use, which
 * is the "org provisioning" seam the GitHub App install later reconciles
 * (`github_installation_id`).
 */

export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/@.*$/, "") // drop the email domain
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "org";
}

/**
 * The user's active org id: the active-org cookie's org when they still belong
 * to it, else their oldest membership (`active-org-core.ts`). The cookie only
 * selects among the user's own memberships, so a stale or foreign id can never
 * grant access — it falls back. Uncached: provisioning re-asks after its writes.
 */
async function activeOrgIdFor(userId: string): Promise<string | null> {
  const [memberships, cookieValue] = await Promise.all([
    listMembershipRefs(userId),
    readActiveOrgCookie(),
  ]);
  return resolveActiveOrgId(memberships, cookieValue);
}

async function orgForUser(userId: string): Promise<Org | null> {
  const orgId = await activeOrgIdFor(userId);
  if (!orgId) return null;
  return getOrgById(orgId);
}

/**
 * The org id to act on for THIS request: the URL's `/o/{slug}` org when the
 * proxy set one (membership verified — never silently falls back to a
 * different org when the slug is foreign or invalid), else the active org.
 *
 * Per-request cached (the layout, the page guard and the page's reads all ask),
 * and the cookie is read INSIDE the cached function, so the cache can never hand
 * back an org resolved before the cookie was considered. A server action that
 * switches the org sets the cookie and the next request resolves afresh.
 */
const resolveAmbientOrgId = cache(async (userId: string): Promise<string | null> => {
  const slug = (await headers()).get(ACTIVE_ORG_HEADER);
  if (!slug) return activeOrgIdFor(userId);
  const org = await getOrgBySlug(slug);
  if (!org) return null;
  const role = await getMembershipRole(org.id, userId);
  return role ? org.id : null;
});

/** The signed-in user's org, or null when signed-out / not yet provisioned /
 *  the URL's org isn't one they belong to. */
export async function getCurrentOrg(): Promise<Org | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;
  const orgId = await resolveAmbientOrgId(user.id);
  return orgId ? getOrgById(orgId) : null;
}

/**
 * The signed-in user's org + their role in it. Read-only (no provisioning).
 *
 * Pass `orgId` to resolve membership in a SPECIFIC org (re-resolving the role
 * there) rather than the ambient `/o/{slug}` resolution — used when an action
 * already has a target org in hand (e.g. accepting an invite to a different
 * org than the one in the current URL).
 */
export async function getCurrentMembership(orgId?: string): Promise<OrgMembership | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;

  const resolvedOrgId = orgId ?? (await resolveAmbientOrgId(user.id));
  if (!resolvedOrgId) return null;

  const membership = await getUserMembership(user.id, resolvedOrgId);
  if (!membership) return null;

  const org = await getOrgById(membership.org_id);
  if (!org) return null;
  return { org, role: membership.role, userId: user.id };
}

/** Like {@link getCurrentMembership} but provisions a personal org (admin) on first use. */
export async function getOrCreateMembership(): Promise<OrgMembership | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;
  const org = await getOrCreateOrg();
  if (!org) return null;
  const role = await getMembershipRole(org.id, user.id);
  if (!role) return null;
  return { org, role, userId: user.id };
}

/** The signed-in user's org, provisioning a personal one on first use. */
export async function getOrCreateOrg(): Promise<Org | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;

  const existing = await orgForUser(user.id);
  if (existing) return existing;

  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const githubLogin =
    typeof metadata.user_name === "string"
      ? metadata.user_name
      : typeof metadata.preferred_username === "string"
        ? metadata.preferred_username
        : slugify(user.email ?? user.id);
  const name =
    typeof metadata.full_name === "string" && metadata.full_name.trim()
      ? metadata.full_name
      : githubLogin;

  // `github_login` is globally unique — fall back to a suffixed slug on collision
  // (two email users can derive the same slug). The membership re-check below also
  // covers the case where a concurrent request already provisioned this user.
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate =
      attempt === 0 ? githubLogin : `${slugify(githubLogin)}-${randomBytes(2).toString("hex")}`;
    const org = await insertOrg(candidate, name);

    if (org) {
      // Await + check the owner-membership insert. If it fails, the org row exists
      // but the user has no membership — and because orgForUser keys off memberships, a
      // retry would create a brand-new orphan org each call. Roll the org back and
      // surface the failure rather than swallowing it and admitting a roleless user.
      const bootstrapped = await insertBootstrapMembership(org.id, user.id);
      if (!bootstrapped) {
        await deleteOrgRow(org.id);
        return null;
      }
      return org;
    }
    // A concurrent request may have provisioned the user's org in the meantime.
    const raced = await orgForUser(user.id);
    if (raced) return raced;
  }

  return orgForUser(user.id);
}
