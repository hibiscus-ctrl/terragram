import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A minimal reader for Terragram's single Supabase migration, so the RLS posture
 * can be asserted in CI without a database.
 *
 * A TEXT read, not a live query: the migration file is what gets applied, so an
 * invariant proved here holds for every environment, and it runs with no
 * credentials. It cannot prove Postgres ENFORCES the policies — that is
 * `rls-runtime.test.ts` — only that the intended posture is declared, complete,
 * and has not silently regressed when a table was added.
 */

const MIGRATION = fileURLToPath(
  new URL("../../supabase/migrations/20240101000000_database.sql", import.meta.url),
);

/** The migration with line comments removed and CRLF normalised, so a commented
 *  example can never satisfy (or trip) a statement pattern. */
export function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .replace(/\r/g, "")
    .replace(/--.*$/gm, "");
}

/** Every table the migration creates. */
export function declaredTables(sql: string): string[] {
  return [...sql.matchAll(/^create table (?:if not exists )?(?:public\.)?(\w+)\s*\(/gim)].map((m) =>
    String(m[1]),
  );
}

/** Tables the migration explicitly turns RLS on for. */
export function rlsEnabledTables(sql: string): Set<string> {
  return new Set(
    [...sql.matchAll(/^alter table (?:public\.)?(\w+) enable row level security/gim)].map((m) =>
      String(m[1]),
    ),
  );
}

export type Policy = {
  name: string;
  table: string;
  /** `select`, `all`, … as written. */
  command: string;
  /** Roles after `to`, lowercased and split; empty when the policy is unscoped. */
  roles: string[];
  /** The `using (...)` expression, whitespace-collapsed. */
  using: string;
  /** The `with check (...)` expression, whitespace-collapsed; empty when absent. */
  check: string;
};

/** `create policy` statements, including a trailing `with check`. */
export function declaredPolicies(sql: string): Policy[] {
  const re =
    /create policy "([^"]+)" on (?:public\.)?(\w+)(?: as (?:restrictive|permissive))? for (\w+)(?: to ([\w, ]+?))?\s+using \(([\s\S]*?)\)(?:\s+with check \(([\s\S]*?)\))?\s*;/gi;
  const squash = (s: string | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
  return [...sql.matchAll(re)].map((m) => ({
    name: String(m[1]),
    table: String(m[2]),
    command: String(m[3]).toLowerCase(),
    roles: String(m[4] ?? "")
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
    using: squash(m[5]),
    check: squash(m[6]),
  }));
}

/** `grant <privileges> on <tables> to <roles>;` statements, one entry per table. */
export function declaredGrants(sql: string): { table: string; privileges: string; roles: string[] }[] {
  const out: { table: string; privileges: string; roles: string[] }[] = [];
  for (const m of sql.matchAll(/^grant ([\w, ]+?) on\s+([\w,\s.]+?)\s+to ([\w, ]+);/gim)) {
    const roles = String(m[3])
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    for (const table of String(m[2]).split(",")) {
      const name = table.trim().replace(/^public\./, "");
      if (name) out.push({ table: name, privileges: String(m[1]).toLowerCase(), roles });
    }
  }
  return out;
}

/** Table-level constraint keywords that start a line like a column would. */
const NOT_A_COLUMN = new Set(["unique", "primary", "foreign", "check", "constraint", "exclude"]);

/** Column names declared in a table's `create table` body. */
export function columnsOf(sql: string, table: string): string[] {
  const re = new RegExp(`^create table (?:if not exists )?${table}\\s*\\(([\\s\\S]*?)^\\);`, "im");
  const body = re.exec(sql);
  if (!body) return [];
  return [...String(body[1]).matchAll(/^\s{2}(\w+)\s+/gm)]
    .map((m) => String(m[1]))
    .filter((c) => !NOT_A_COLUMN.has(c.toLowerCase()));
}
