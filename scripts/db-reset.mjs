// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rebuild TERRAGRAM'S OWN TABLES from scratch — the answer to "if we wipe
 * Terragram's data, do we get the exact same schema back?".
 *
 * SCOPE: `terragram_*` only. It drops the six tables this product owns and
 * rebuilds them from `supabase/migrations/20240101000000_database.sql`. Nothing
 * else in `public` is touched.
 *
 * That scope is the whole point. This script used to run `drop schema public
 * cascade` — inherited from the Infraweaver Cloud reset, where the whole schema
 * belongs to one product. Terragram shares a Supabase project with Infraweaver
 * during development, so that statement would have destroyed every org, run,
 * finding and billing linkage in the shared database. A reset that can reach
 * another product's data is not a reset, it is an outage.
 *
 * WIPED: every Terragram workspace, snapshot, evidence receipt, share link and
 * per-user preference. PRESERVED: everything else, including your Supabase Auth
 * login — the tables key on `auth.users`, which this never drops.
 *
 * Usage (loads .env.local first via the db:reset npm script):
 *   npm run db:reset -- --yes
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRef, runSql } from "./supabase-query.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(here, "..", "supabase", "migrations", "20240101000000_database.sql");

/** The tables this product owns, children first so the cascade is never needed to
 *  reach across an ownership boundary. Adding a table here is the same edit as
 *  adding it to the migration; a table missing from this list survives a reset. */
const OWNED = [
  "terragram_share_links",
  "terragram_evidence_bundles",
  "terragram_workspace_snapshots",
  "terragram_workspaces",
  "terragram_user_settings",
  "terragram_git_connections",
];

const WIPE = OWNED.map((t) => `drop table if exists public.${t} cascade;`).join("\n");

async function main() {
  const ref = projectRef();
  const args = process.argv.slice(2);

  if (!args.includes("--yes")) {
    console.error(
      `db:reset DROPS and rebuilds Terragram's tables in project ${ref}:\n` +
        `  ${OWNED.join(", ")}\n` +
        "Every workspace, snapshot, receipt and share link is lost. Nothing outside\n" +
        "those tables is touched.\n" +
        "Re-run with --yes to confirm:  npm run db:reset -- --yes",
    );
    process.exit(1);
  }

  const schema = readFileSync(SCHEMA_FILE, "utf8");

  console.log(`Resetting Terragram tables in project ${ref} …`);
  console.log(`  1/2  dropping ${OWNED.length} terragram_* tables`);
  await runSql(WIPE);
  console.log("  2/2  rebuilding from database.sql");
  await runSql(schema);

  console.log("\nDone. Run `npm run db:types` to regenerate the typed client.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
