// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which org the dashboard acts on, when the user belongs to more than one. Pure, so
 * the rules are unit tested; `get-or-create-org.ts` reads the cookie and the
 * memberships and binds them.
 *
 * The cookie only ever SELECTS among the caller's own memberships. It is a
 * preference, never a grant: an id the user is not a member of (a stale cookie
 * after leaving or being removed, or one written by hand) is ignored, and the
 * request falls back to the oldest membership exactly as if there were no cookie.
 */

/** The httpOnly cookie holding the active org's id. */
export const ACTIVE_ORG_COOKIE = "tg_active_org";

/** One of the caller's memberships, as the resolver needs it. */
export type MembershipRef = { orgId: string; createdAt: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The org id a cookie value names, or null when it is not even shaped like one. */
export function parseActiveOrgCookie(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  return value && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The org this request acts on: the cookie's org when the caller is still a member
 * of it, else their oldest membership (ties broken by org id, so the answer does
 * not depend on row order), else null when they belong to no org.
 */
export function resolveActiveOrgId(
  memberships: readonly MembershipRef[],
  cookieValue: string | null | undefined,
): string | null {
  const wanted = parseActiveOrgCookie(cookieValue);
  const chosen = wanted ? memberships.find((m) => m.orgId.toLowerCase() === wanted) : undefined;
  if (chosen) return chosen.orgId;
  const oldest = [...memberships].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.orgId.localeCompare(b.orgId),
  )[0];
  return oldest?.orgId ?? null;
}

/** Whether the caller may switch to `orgId`: only to an org they belong to. */
export function canSwitchTo(memberships: readonly MembershipRef[], orgId: string): boolean {
  const wanted = parseActiveOrgCookie(orgId);
  return wanted !== null && memberships.some((m) => m.orgId.toLowerCase() === wanted);
}

/**
 * The cookie's attributes. httpOnly (no script needs it), SameSite=Lax (a
 * cross-site POST cannot carry it into an action), Secure wherever the site is
 * served over HTTPS, and long-lived: it is a preference the next visit should keep.
 */
export function activeOrgCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
}
