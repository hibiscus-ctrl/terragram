// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { revalidatePath } from "next/cache";

import { setActiveOrgCookie } from "@/features/account/controllers/active-org";
import { canSwitchTo, parseActiveOrgCookie } from "@/features/account/controllers/active-org-core";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { listMembershipRefs } from "@/features/data/orgs";

/**
 * Switch the dashboard to another of the caller's orgs. Any role may: it changes
 * which of their own memberships the dashboard acts on, nothing about the org. An
 * org they do not belong to is refused here, and would be ignored by the resolver
 * anyway, so the cookie can never widen what they can reach.
 */
export async function switchActiveOrg(
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, error: "Sign in to switch organisation." };

  const id = parseActiveOrgCookie(String(orgId));
  if (!id || !canSwitchTo(await listMembershipRefs(user.id), id)) {
    return { ok: false, error: "You are not a member of that organisation." };
  }

  await setActiveOrgCookie(id);
  revalidatePath("/", "layout");
  return { ok: true };
}
