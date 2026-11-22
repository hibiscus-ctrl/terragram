/**
 * Seeding for the suites that need a signed-in user and real rows, through the
 * service-role client — the same write path the app's data layer uses.
 *
 * SCOPE, because the Supabase project is shared with Infraweaver Cloud: a seed
 * writes `auth.users` and `terragram_*` rows only. Signing a seeded user in runs
 * the real provisioning path, which creates a personal org + membership in the
 * shared tables; `deleteUser()` removes that org (only when it is the user's own
 * `apitest-terragram-*` org) before deleting the auth user, whose
 * `on delete cascade` takes every `terragram_*` row with it.
 */
import { createHash, randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../../src/libs/supabase/types.ts";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SECRET =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** True when the service-role env needed for seeding is present. */
export const CAN_SEED = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SECRET);

/** Every seeded identity starts with this, so a crashed run is greppable. */
const SEED_PREFIX = "apitest-terragram-";

export type Admin = SupabaseClient<Database>;

export function adminClient(): Admin {
  return createClient<Database>(SUPABASE_URL, SUPABASE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A fresh seeded address: `apitest-terragram-<who>-<hex>@example.invalid`. */
export function seedEmail(who: string): string {
  return `${SEED_PREFIX}${who}-${randomBytes(4).toString("hex")}@example.invalid`;
}

/** Mirror of `hashToken` in src/features/workspace/store.ts. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A workspace owned by `userId` with one empty-model snapshot whose transcript
 *  carries `name`, so a rendered canvas that shows it is unambiguously this one. */
export async function seedWorkspace(
  admin: Admin,
  userId: string,
  name: string,
): Promise<string> {
  const { data, error } = await admin
    .from("terragram_workspaces")
    .insert({ user_id: userId, name, mode: "chat-diagram", cloud: "azure" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedWorkspace failed: ${error?.message}`);
  const snap = await admin
    .from("terragram_workspace_snapshots")
    .insert({
      workspace_id: data.id,
      model: { nodes: [], edges: [], topology: "derived" },
      transcript: [{ role: "user", text: name }],
    });
  if (snap.error) throw new Error(`seed snapshot failed: ${snap.error.message}`);
  return data.id;
}

/** A share link the way `createShareLink` writes one; returns the raw token. */
export async function seedShareLink(
  admin: Admin,
  userId: string,
  workspaceId: string,
  state: "live" | "revoked" | "expired" = "live",
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const day = 86_400_000;
  const { error } = await admin.from("terragram_share_links").insert({
    workspace_id: workspaceId,
    created_by: userId,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + (state === "expired" ? -day : day)).toISOString(),
    revoked_at: state === "revoked" ? new Date().toISOString() : null,
  });
  if (error) throw new Error(`seedShareLink failed: ${error.message}`);
  return token;
}

/**
 * Delete a seeded user and everything their sign-in provisioned. Refuses any
 * address outside the seed prefix, so a typo can never reach a real account.
 */
export async function deleteUser(admin: Admin, userId: string, email: string): Promise<void> {
  if (!email.startsWith(SEED_PREFIX)) throw new Error(`refusing to delete non-seed user ${email}`);
  const { data: memberships } = await admin
    .from("memberships")
    .select("org_id, orgs(github_login)")
    .eq("user_id", userId);
  for (const m of memberships ?? []) {
    const login = (m as { orgs?: { github_login?: string } | null }).orgs?.github_login ?? "";
    // Only the personal org provisioning minted from this address (its slug is
    // derived from the email); an org the user merely joined is left alone.
    if (login.startsWith(SEED_PREFIX)) await admin.from("orgs").delete().eq("id", m.org_id);
  }
  await admin.auth.admin.deleteUser(userId);
}
