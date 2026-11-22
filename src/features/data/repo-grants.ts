// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

/**
 * Per-member repo restriction — orthogonal to role. A membership with NO rows
 * here is unrestricted (sees every repo in the org — today's behaviour for
 * every existing member); one or more rows scopes that member to exactly
 * those repos, regardless of role. See `membership_repo_grants` in the
 * consolidated schema for the full invariant.
 */

/** Replace-all: set this member's granted repos to exactly `repoIds` (empty
 *  clears the restriction — the member goes back to seeing everything). */
export async function setRepoGrants(
  orgId: string,
  userId: string,
  repoIds: string[],
): Promise<boolean> {
  const { error: deleteError } = await supabaseAdminClient
    .from("membership_repo_grants")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", userId);
  if (deleteError) return false;
  if (repoIds.length === 0) return true;

  const { error: insertError } = await supabaseAdminClient
    .from("membership_repo_grants")
    .insert(repoIds.map((repoId) => ({ org_id: orgId, user_id: userId, repo_id: repoId })));
  return !insertError;
}
