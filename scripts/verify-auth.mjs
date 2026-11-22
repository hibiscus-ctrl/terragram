// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read-only auth/provisioning verification. Uses the service-role key from
 * .env.local to dump the auth users + orgs + memberships, so we can confirm a
 * GitHub sign-in created the expected rows.
 *
 * Run: npm run db:verify-auth   (env-cmd loads .env.local)
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const out = { project: url };

try {
  const { data, error } = await supabase.auth.admin.listUsers();
  if (error) throw error;
  out.authUsers = data.users.map((u) => ({
    id: u.id,
    email: u.email,
    provider: u.app_metadata?.provider,
    user_name: u.user_metadata?.user_name ?? u.user_metadata?.preferred_username,
    created_at: u.created_at,
  }));
} catch (e) {
  out.authUsersError = String(e?.message ?? e);
}

const orgs = await supabase.from("orgs").select("id, github_login, name, plan, created_at");
out.orgs = orgs.error ? { error: orgs.error.message } : orgs.data;

const memberships = await supabase.from("memberships").select("org_id, user_id, role, created_at");
out.memberships = memberships.error ? { error: memberships.error.message } : memberships.data;

console.log(JSON.stringify(out, null, 2));
