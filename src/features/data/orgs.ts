// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { logger } from "@/libs/log";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";
import type { Database } from "@/libs/supabase/types";

const log = logger("data/orgs");

/**
 * Dashboard data access for `orgs` rows and the org-bootstrap lookups. Part of
 * the `features/data/` family (see `repos.ts` for the rationale).
 */

export type OrgRow = Database["public"]["Tables"]["orgs"]["Row"];

export async function getOrgById(orgId: string): Promise<OrgRow | null> {
  const { data } = await supabaseAdminClient.from("orgs").select("*").eq("id", orgId).maybeSingle();
  return data ?? null;
}

/** Org by its URL slug (`github_login` — unique, URL-safe). The lookup the
 *  `/o/{slug}/...` route tree resolves every request against. */
export async function getOrgBySlug(slug: string): Promise<OrgRow | null> {
  const { data } = await supabaseAdminClient
    .from("orgs")
    .select("*")
    .eq("github_login", slug)
    .maybeSingle();
  return data ?? null;
}

export type UserOrgRow = {
  id: string;
  slug: string;
  name: string;
  role: Database["public"]["Enums"]["org_role"];
  plan: string;
};

/** Every org this user belongs to, oldest membership first — the org-switcher list. */
export async function listOrgsForUser(userId: string): Promise<UserOrgRow[]> {
  const { data } = await supabaseAdminClient
    .from("memberships")
    .select("role, created_at, orgs(id, github_login, name, plan)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data ?? []).flatMap((row) => {
    const org = row.orgs as { id: string; github_login: string; name: string | null; plan: string } | null;
    if (!org) return [];
    return [
      { id: org.id, slug: org.github_login, name: org.name ?? org.github_login, role: row.role, plan: org.plan },
    ];
  });
}

/** The user's memberships as the active-org resolver needs them (`active-org-core.ts`). */
export async function listMembershipRefs(
  userId: string,
): Promise<{ orgId: string; createdAt: string }[]> {
  const { data } = await supabaseAdminClient
    .from("memberships")
    .select("org_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((row) => ({ orgId: row.org_id, createdAt: row.created_at }));
}

/** Insert a fresh org; null when the github_login collides (caller retries). */
export async function insertOrg(githubLogin: string, name: string): Promise<OrgRow | null> {
  const { data } = await supabaseAdminClient
    .from("orgs")
    .insert({ github_login: githubLogin, name })
    .select("*")
    .maybeSingle();
  return data ?? null;
}

/** Bootstrap membership for a fresh personal org. Returns false so the caller can
 *  roll the org back rather than admit a roleless user. */
export async function insertBootstrapMembership(orgId: string, userId: string): Promise<boolean> {
  const { error } = await supabaseAdminClient
    .from("memberships")
    .insert({ org_id: orgId, user_id: userId, role: "admin", joined_via: "created" });
  if (error) {
    log.error("insertBootstrapMembership failed", { orgId, err: error.message });
    return false;
  }
  return true;
}

/** The managed-models kill switch — `/api/proxy-token` declines when opted out. */
export async function setOrgManagedOptOut(orgId: string, optOut: boolean): Promise<boolean> {
  const { error } = await supabaseAdminClient
    .from("orgs")
    .update({ managed_opt_out: optOut })
    .eq("id", orgId);
  return !error;
}

/** Persist the org's Stripe customer id (written once, reused by later checkouts). */
export async function setOrgStripeCustomer(orgId: string, customerId: string): Promise<void> {
  await supabaseAdminClient
    .from("orgs")
    .update({ stripe_customer_id: customerId })
    .eq("id", orgId);
}

export async function deleteOrgRow(orgId: string): Promise<boolean> {
  const { error } = await supabaseAdminClient.from("orgs").delete().eq("id", orgId);
  return !error;
}
