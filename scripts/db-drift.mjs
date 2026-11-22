/**
 * Compare `database.sql`'s DECLARED columns against the LIVE schema and report
 * anything the file thinks exists but the database does not.
 *
 * WHY THIS EXISTS. `db:apply` converges by re-running one idempotent file, and
 * its main tool is `create table if not exists`. On a database where the table
 * ALREADY EXISTS that statement is a no-op, so a column added to the create-table
 * block is silently never created. The file's convention is therefore that a
 * column added after a table's first release also needs an explicit
 * `alter table … add column if not exists` in the CONVERGE DELTAS section.
 * Forget it and `db:apply` still prints OK. This derives the expected set from the
 * file itself, so it covers every delta, not just the ones someone remembered.
 *
 * SCOPE: `terragram_*` tables only. The Supabase project is shared with
 * Infraweaver Cloud, whose tables this migration does not declare and must not be
 * judged against.
 *
 * Read-only — it issues no DDL and writes nothing. Exit 1 on drift.
 *
 * Usage:  npm run db:drift
 */
import { readFileSync } from "node:fs";
import { projectRef, runSql } from "./supabase-query.mjs";

const FILE = "./supabase/migrations/20240101000000_database.sql";
const PREFIX = "terragram_";

/** Columns declared in each `create table if not exists terragram_*` block. */
function declaredColumns(sql) {
  const out = new Map();
  const blocks = /create table if not exists\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi;
  for (const m of sql.matchAll(blocks)) {
    const [, table, rawBody] = m;
    if (!table.startsWith(PREFIX)) continue;
    // Strip line comments BEFORE splitting: a comma inside a comment is not a
    // column separator. (`.` does not match `\r`, so drop CR first or an anchored
    // strip silently no-ops on a CRLF checkout.)
    const body = rawBody
      .split("\n")
      .map((l) => l.replace(/\r/g, "").replace(/--.*/, ""))
      .join("\n");
    const chunks = [];
    let depth = 0;
    let cur = "";
    for (const ch of body) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        chunks.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    chunks.push(cur);
    const names = [];
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
      if (!line) continue;
      const first = line.split(/\s+/)[0].toLowerCase();
      // table-level constraints, not columns
      if (["primary", "unique", "foreign", "constraint", "check", "exclude"].includes(first))
        continue;
      names.push(first);
    }
    out.set(table, names);
  }
  return out;
}

/** `table.column` pairs that carry an explicit converge statement. */
function convergedColumns(sql) {
  const out = new Set();
  const re = /alter table\s+(?:public\.)?(\w+)\s+add column if not exists\s+(\w+)/gi;
  for (const m of sql.matchAll(re)) out.add(`${m[1]}.${m[2]}`);
  return out;
}

const sql = readFileSync(FILE, "utf8");
const declared = declaredColumns(sql);
const converged = convergedColumns(sql);

const rows = JSON.parse(
  await runSql(
    `select table_name, string_agg(column_name, ',' order by column_name) as cols
     from information_schema.columns
     where table_schema = 'public' and table_name like '${PREFIX}%'
     group by table_name`,
  ),
);
const live = new Map(rows.map((r) => [r.table_name, new Set(String(r.cols).split(","))]));

const problems = [];
for (const [table, cols] of declared) {
  const liveCols = live.get(table);
  if (!liveCols) {
    problems.push({ table, column: null, fix: `table '${table}' does not exist live` });
    continue;
  }
  for (const column of cols) {
    if (liveCols.has(column)) continue;
    problems.push({
      table,
      column,
      fix: converged.has(`${table}.${column}`)
        ? "declared WITH a converge line but not present live — run db:apply (or a previous apply failed partway)"
        : `MISSING CONVERGE LINE — add: alter table ${table} add column if not exists ${column} <type>;`,
    });
  }
}

if (problems.length === 0) {
  console.log(
    `no drift (project ${projectRef()}): every ${PREFIX}* column declared in database.sql exists live.`,
  );
  process.exit(0);
}

console.error(`SCHEMA DRIFT (project ${projectRef()}) — ${problems.length} problem(s):\n`);
for (const p of problems) {
  console.error(`  ${p.table}${p.column ? `.${p.column}` : ""}`);
  console.error(`    ${p.fix}\n`);
}
console.error(
  "A missing converge line means db:apply printed OK while doing nothing for that column.\n" +
    "Add the alter statement to the CONVERGE DELTAS section of database.sql, then re-run db:apply.",
);
process.exit(1);
