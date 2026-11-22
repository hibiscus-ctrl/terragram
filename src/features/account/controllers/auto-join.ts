import type { User } from "@supabase/supabase-js";

import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

import { resolveAutoJoinOrg } from "./auto-join-core";

/** Which org's SSO mapping owns this Supabase SSO provider, if any. A failed read
 *  answers null, which auto-joins nothing. */
async function findOrgBySsoProvider(providerId: string): Promise<string | null> {
  const { data } = await supabaseAdminClient
    .from("org_sso")
    .select("org_id")
    .eq("provider_id", providerId)
    .maybeSingle();
  return data?.org_id ?? null;
}

/**
 * The org filter a sign-in's email-match auto-join must apply (`auto-join-core.ts`):
 * `{ orgId: null }` = any org, `{ orgId }` = that org only, `null` = nothing.
 * Takes the full `User` from the Auth server — the provider list is not a JWT claim.
 */
export function autoJoinScopeFor(user: User): Promise<{ orgId: string | null } | null> {
  return resolveAutoJoinOrg(user, findOrgBySsoProvider);
}
