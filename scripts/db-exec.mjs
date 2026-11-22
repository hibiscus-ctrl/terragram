/**
 * Run arbitrary SQL against the LIVE Supabase project from the terminal — the
 * reusable path for a schema delta (an `alter table ...`) or a quick query,
 * without the dashboard SQL editor, Docker, or a local `pg` client.
 *
 * Usage (via the db:exec npm script, which loads .env.local first):
 *   npm run db:exec -- "alter table public.findings add column if not exists doc_url text;"
 *   npm run db:exec -- ./supabase/migrations/20240101000000_database.sql
 */
import { readFileSync } from "node:fs";
import { projectRef, runSql } from "./supabase-query.mjs";

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/db-exec.mjs "<sql>" | <path/to/file.sql>');
  process.exit(1);
}

// A bare ".sql" arg is read as a file; anything else is treated as inline SQL.
const query = arg.toLowerCase().endsWith(".sql") ? readFileSync(arg, "utf8") : arg;

try {
  const body = await runSql(query);
  console.log(`OK (project ${projectRef()}).${body && body !== "[]" ? `\n${body}` : ""}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
