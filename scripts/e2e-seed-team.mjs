/**
 * E2E helper: undo what the members spec does to the e2e user's organisation.
 * Removes every `e2e-invitee*` member from it and deletes every pending invite to
 * an `e2e-invitee*` address. Idempotent — run before and after the spec, so a run
 * that crashed half-way never leaves a member or a live invite behind (a pending
 * invite would also auto-join the invitee at their next sign-in).
 *
 *   node scripts/e2e-seed-team.mjs [admin email] [invitee prefix]
 *
 * Prints a single JSON line last — the Cypress task parses it:
 *   {"removedMembers": <n>, "removedInvites": <n>}
 *
 * SCOPE: the e2e user's OLDEST org (the one the dashboard shows) and only
 * memberships and invites of `e2e-invitee*` addresses in it. The Supabase project
 * is shared with Infraweaver Cloud; nothing else is read or written. Memberships
 * are removed through `set_membership`, the same last-Admin-guarded function the
 * app uses, so this can never leave the org without an Admin.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const adminEmail = process.argv[2] || "test@terragram.dev";
const inviteePrefix = process.argv[3] || "e2e-invitee";

if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}
if (!inviteePrefix.startsWith("e2e-")) {
  console.error(`Refusing to clean up "${inviteePrefix}*": the prefix must start with e2e-.`);
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Every auth user, paged. The admin API has no get-by-email. */
async function listUsers() {
  const users = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < 200) break;
  }
  return users;
}

const users = await listUsers();
const adminUser = users.find((u) => u.email?.toLowerCase() === adminEmail.toLowerCase());
if (!adminUser) {
  console.error(`${adminEmail} does not exist — run the seedUser task (or npm run db:test-user) first.`);
  process.exit(1);
}

const { data: membership, error: membershipError } = await admin
  .from("memberships")
  .select("org_id")
  .eq("user_id", adminUser.id)
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();
if (membershipError) {
  console.error(`membership lookup failed: ${membershipError.message}`);
  process.exit(1);
}
if (!membership) {
  console.log(JSON.stringify({ removedMembers: 0, removedInvites: 0 }));
  process.exit(0);
}
const orgId = membership.org_id;

let removedMembers = 0;
for (const invitee of users.filter((u) => u.email?.toLowerCase().startsWith(inviteePrefix))) {
  const { data, error } = await admin.rpc("set_membership", {
    p_org: orgId,
    p_user: invitee.id,
    p_role: null,
  });
  if (error) {
    console.error(`removing ${invitee.email} failed: ${error.message}`);
    process.exit(1);
  }
  if (data === "ok") removedMembers++;
}

const { data: invites, error: inviteError } = await admin
  .from("org_invites")
  .delete()
  .eq("org_id", orgId)
  .like("email", `${inviteePrefix}%`)
  .is("accepted_at", null)
  .select("id");
if (inviteError) {
  console.error(`invite cleanup failed: ${inviteError.message}`);
  process.exit(1);
}

console.log(JSON.stringify({ removedMembers, removedInvites: invites?.length ?? 0 }));
