// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { cookies } from "next/headers";

import { ACTIVE_ORG_COOKIE, activeOrgCookieOptions } from "./active-org-core";

/**
 * The active-org cookie's I/O. What the value MEANS — and that it is never trusted
 * beyond the caller's own memberships — is `active-org-core.ts`; the resolver in
 * `get-or-create-org.ts` reads it, the switcher and invite acceptance write it.
 */

/** The raw cookie value, unvalidated. */
export async function readActiveOrgCookie(): Promise<string | null> {
  return (await cookies()).get(ACTIVE_ORG_COOKIE)?.value ?? null;
}

/** Make `orgId` the active org. Only from a server action or a route handler (a
 *  render cannot set cookies), and only for an org the caller belongs to — the
 *  resolver would ignore any other id, but the caller should not write one. */
export async function setActiveOrgCookie(orgId: string): Promise<void> {
  (await cookies()).set(
    ACTIVE_ORG_COOKIE,
    orgId,
    activeOrgCookieOptions(process.env.NODE_ENV === "production"),
  );
}
