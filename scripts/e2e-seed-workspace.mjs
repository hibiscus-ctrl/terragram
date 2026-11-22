// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E helper: ensure the e2e user owns ONE deterministic fixture workspace with a
 * known three-step snapshot history, so the workspace list, the canvas and the
 * history menu have something stable to render. Idempotent — the workspace is
 * found by name and its snapshots are reset to the designed set on every run.
 *
 *   node scripts/e2e-seed-workspace.mjs [email]             # seed
 *   node scripts/e2e-seed-workspace.mjs [email] --cleanup   # remove every e2e-* workspace
 *
 * Preconditions: the user exists (the Cypress `seedUser` task / cy.login()).
 *
 * Prints a single JSON line last — the Cypress task parses it, so specs never
 * hard-code an id:
 *   seed:    {"id": "<uuid>", "name": "e2e-fixture-workspace", "snapshots": 3}
 *   cleanup: {"cleaned": <workspaces deleted>}
 *
 * SCOPE: `terragram_*` rows of this one user, and only workspaces named `e2e-*`
 * (snapshots, receipts and share links cascade). The Supabase project is shared
 * with Infraweaver Cloud; nothing else is read or written.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const email = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "test@terragram.dev";
const cleanup = process.argv.includes("--cleanup");

/** Distinctive on purpose: a human scanning the table sees it is fixture data. */
const FIXTURE_NAME = "e2e-fixture-workspace";
const E2E_PREFIX = "e2e-";

if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** The user's id. The admin API has no get-by-email; scan the pages. */
async function findUserId(address) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === address.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

const node = (id, kind, category, label) => ({ id, kind, category, label, flag: null });
const edge = (source, target) => ({ id: `${source}->${target}`, source, target, origin: "derived" });

/** The designed history, oldest first: each step adds one resource. */
const HISTORY = [
  [node("web", "app-service", "compute", "e2e web app")],
  [node("web", "app-service", "compute", "e2e web app"), node("db", "postgres", "storage", "e2e database")],
  [
    node("web", "app-service", "compute", "e2e web app"),
    node("db", "postgres", "storage", "e2e database"),
    node("cache", "redis-cache", "storage", "e2e cache"),
  ],
].map((nodes) => ({
  nodes,
  edges: nodes.slice(1).map((n) => edge("web", n.id)),
  topology: "derived",
}));

const userId = await findUserId(email);
if (!userId) {
  console.error(`${email} does not exist — run the seedUser task (or npm run db:test-user) first.`);
  process.exit(1);
}

if (cleanup) {
  const { data, error } = await admin
    .from("terragram_workspaces")
    .delete()
    .eq("user_id", userId)
    .like("name", `${E2E_PREFIX}%`)
    .select("id");
  if (error) {
    console.error(`cleanup failed: ${error.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ cleaned: data?.length ?? 0 }));
  process.exit(0);
}

let { data: existing } = await admin
  .from("terragram_workspaces")
  .select("id")
  .eq("user_id", userId)
  .eq("name", FIXTURE_NAME)
  .maybeSingle();

if (!existing) {
  const { data, error } = await admin
    .from("terragram_workspaces")
    .insert({ user_id: userId, name: FIXTURE_NAME, mode: "chat-diagram", cloud: "azure", tool: "terraform" })
    .select("id")
    .single();
  if (error) {
    console.error(`workspace insert failed: ${error.message}`);
    process.exit(1);
  }
  existing = data;
}

// Converge the history: whatever a previous run (or a spec's autosave) left,
// the fixture always starts from exactly these three snapshots, one second apart
// so their order is unambiguous.
await admin.from("terragram_workspace_snapshots").delete().eq("workspace_id", existing.id);
const base = Date.now() - HISTORY.length * 1000;
const { error: snapError } = await admin.from("terragram_workspace_snapshots").insert(
  HISTORY.map((model, i) => ({
    workspace_id: existing.id,
    model,
    transcript: [{ role: "user", text: `e2e step ${i + 1}` }],
    created_at: new Date(base + i * 1000).toISOString(),
  })),
);
if (snapError) {
  console.error(`snapshot insert failed: ${snapError.message}`);
  process.exit(1);
}
await admin
  .from("terragram_workspaces")
  .update({ updated_at: new Date().toISOString() })
  .eq("id", existing.id);

console.log(JSON.stringify({ id: existing.id, name: FIXTURE_NAME, snapshots: HISTORY.length }));
