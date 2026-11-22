// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drive the Supabase CLI entirely from .env.local, so the project it targets is
 * ALWAYS the one in this repo's .env.local — never a stale `supabase link` cache
 * (supabase/.temp/project-ref) left over from some other project.
 *
 * The npm scripts invoke this through `env-cmd -f ./.env.local`, which loads
 * .env.local into the environment first. We then:
 *   - resolve the project ref from SUPABASE_PROJECT_REF, else from
 *     NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co), and
 *   - build a direct connection string (db.<ref>.supabase.co) from that ref plus
 *     SUPABASE_DB_PASSWORD, and pass it via `--db-url`.
 *
 * `migrate` uses `--db-url` (direct connection — no Docker, no login). `gen-types`
 * prefers `--project-id` + SUPABASE_ACCESS_TOKEN (Supabase's hosted API — no Docker),
 * and only falls back to `--db-url` (which needs a postgres-meta Docker container)
 * when no token is set. Neither path uses `--linked`, so the stale linked-project
 * cache can't interfere.
 *
 * The CLI is spawned as `node <supabase>/dist/supabase.js <args...>` with an
 * argument ARRAY and shell:false, so the password's @ ! * % characters are passed
 * literally and are never reinterpreted by cmd.exe or bash.
 *
 * Usage: node scripts/supabase-cli.mjs <migrate|gen-types|link>
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const SUPABASE_BIN = join(
  dirname(require.resolve("supabase/package.json")),
  require("supabase/package.json").bin.supabase,
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function projectRef() {
  // .env.local is the source of truth. Prefer the ref derived from
  // NEXT_PUBLIC_SUPABASE_URL (which lives in .env.local) over SUPABASE_PROJECT_REF,
  // because the latter is often exported globally/system-wide by a *different*
  // project and would otherwise silently hijack this repo. SUPABASE_PROJECT_REF is
  // only a fallback for when the URL can't be parsed (e.g. a custom domain).
  const fromUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").match(
    /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in)/i,
  )?.[1];
  const fallback = (
    process.env.SUPABASE_PROJECT_REF ||
    process.env.SUPABASE_PROJECT_ID ||
    ""
  ).trim();
  const ref = fromUrl || fallback;

  if (!ref) {
    fail(
      "Could not resolve the Supabase project ref.\n" +
        "Set NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co) in .env.local.",
    );
  }
  if (!/^[a-z0-9]+$/i.test(ref)) {
    fail(`Resolved project ref "${ref}" is not a valid slug — check .env.local.`);
  }
  return ref;
}

/** Direct (db.<ref>.supabase.co) connection string, with a fully percent-encoded password. */
function dbUrl(ref) {
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) fail("SUPABASE_DB_PASSWORD is not set in .env.local.");
  // The CLI requires a percent-encoded connection string. encodeURIComponent
  // leaves ! * ' ( ) unescaped — encode those too so the value is purely safe.
  const encoded = encodeURIComponent(password).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`;
}

/** Spawn the supabase CLI via node with an argument array (no shell). */
function supabase(args, opts = {}) {
  return spawnSync(process.execPath, [SUPABASE_BIN, ...args], opts);
}

/**
 * Function ARGUMENTS that genuinely accept null at their call sites.
 *
 * Postgres records no nullability for function arguments, so `supabase gen types`
 * has nothing to read and always emits them as non-null. That is not a bug in the
 * CLI — the information does not exist in the catalog — which means the correction
 * has to be re-applied on every single regen. These are infraweaver's shared
 * functions, which this project's types carry too; the committed file was
 * hand-corrected, so a bare regen silently reverted it. Ported from
 * infraweaver-ui's scripts/supabase-cli.mjs — keep the two lists in step.
 * It is applied here instead of by hand, and `patchNullableArgs` throws rather
 * than skip when a target no longer matches — a signature change must be a loud
 * failure, not a quietly-dropped patch.
 */
const NULLABLE_FUNCTION_ARGS = [
  {
    fn: "set_membership",
    arg: "p_role",
    type: 'Database["public"]["Enums"]["org_role"]',
    why: "null clears the role",
  },
  {
    fn: "ratify_suppression_policy",
    arg: "p_justification",
    type: "string",
    why: "justification is optional",
  },
  {
    fn: "record_remediation_close",
    arg: "p_branch",
    type: "string",
    why: "a pull_request payload need not carry head.ref",
  },
  {
    fn: "record_remediation_close",
    arg: "p_event_at",
    type: "string",
    why: "a payload without updated_at degrades to an unconditional write",
  },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Re-apply the nullable-argument corrections to freshly generated types. */
export function patchNullableArgs(source) {
  let out = source;
  const failed = [];
  for (const { fn, arg, type, why } of NULLABLE_FUNCTION_ARGS) {
    // already correct (e.g. re-running over patched output) — leave it alone
    const done = new RegExp(`\\b${arg}:\\s*${escapeRe(type)}\\s*\\|\\s*null`);
    if (done.test(out)) continue;
    // The CLI emits one property per line with NO trailing semicolon; the
    // semicolons in the committed file are added by the formatter afterwards.
    // Accept either, and anchor on the line break so a prefix type can't match.
    const target = new RegExp(
      `(${fn}:\\s*\\{[\\s\\S]*?Args:\\s*\\{[\\s\\S]*?\\n)([ \\t]*)(${arg}:\\s*)${escapeRe(type)}(;?)(?=\\r?\\n)`,
    );
    if (!target.test(out)) {
      failed.push(`${fn}.${arg}`);
      continue;
    }
    out = out.replace(
      target,
      `$1$2// hand-corrected on generation: nullable (${why}). Postgres records no\n` +
        `$2// nullability for function args, so gen-types cannot infer it — see\n` +
        `$2// NULLABLE_FUNCTION_ARGS in scripts/supabase-cli.mjs.\n` +
        `$2$3${type} | null$4`,
    );
  }
  if (failed.length > 0) {
    throw new Error(
      `Could not apply the nullable-argument corrections to: ${failed.join(", ")}.\n` +
        "The generated shape no longer matches, which usually means the function signature changed.\n" +
        "Update NULLABLE_FUNCTION_ARGS in scripts/supabase-cli.mjs — do NOT ignore this: without the\n" +
        "correction those call sites stop type-checking.",
    );
  }
  return out;
}

/**
 * Regenerate src/libs/supabase/types.ts. Prefers the hosted API (--project-id +
 * SUPABASE_ACCESS_TOKEN, no Docker); falls back to --db-url (postgres-meta in
 * Docker) only when no token is set. In best-effort mode a failure is a warning,
 * not an error — used after `migrate` so a successful migration never fails just
 * because types couldn't be regenerated (e.g. no Docker and no token).
 */
function generateTypes(ref, { bestEffort = false } = {}) {
  const hasToken = Boolean(process.env.SUPABASE_ACCESS_TOKEN);
  const args = hasToken
    ? ["gen", "types", "typescript", "--project-id", ref, "--schema", "public"]
    : ["gen", "types", "typescript", "--db-url", dbUrl(ref), "--schema", "public"];

  const result = supabase(args, { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    process.stderr.write(
      "Could not regenerate src/libs/supabase/types.ts.\n" +
        (hasToken
          ? "The hosted `gen types --project-id` call failed — usually a network/TLS issue\n" +
            "(e.g. corporate TLS interception) or an invalid SUPABASE_ACCESS_TOKEN.\n"
          : "Type generation needs SUPABASE_ACCESS_TOKEN (no-Docker, recommended) or Docker.\n" +
            "Create a token at Supabase → Account → Access Tokens and add it to .env.local.\n") +
        (result.stderr || ""),
    );
    if (bestEffort) {
      console.warn(
        "Skipping type generation — the migration itself succeeded; types left unchanged.",
      );
      return;
    }
    process.exit(result.status || 1);
  }

  let types;
  try {
    types = patchNullableArgs(result.stdout);
  } catch (error) {
    // Fail without writing: half-corrected types that compile-but-lie are worse
    // than leaving the previous file in place.
    process.stderr.write(`${error.message}\n`);
    if (bestEffort) {
      console.warn("Skipping type generation — types left unchanged.");
      return;
    }
    process.exit(1);
  }

  writeFileSync("src/libs/supabase/types.ts", types);
  console.log(
    `Wrote src/libs/supabase/types.ts (project ${ref}) — ${NULLABLE_FUNCTION_ARGS.length} nullable-arg correction(s) re-applied.`,
  );
}

const command = process.argv[2];
const ref = projectRef();

if (command === "migrate") {
  const result = supabase(["migration", "up", "--db-url", dbUrl(ref)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  generateTypes(ref, { bestEffort: true });
  process.exit(0);
} else if (command === "dump") {
  // Authoritative single-file schema dump of the public schema (DDL: tables,
  // enums, functions, RLS policies, triggers, grants, indexes) via the direct
  // connection — used to consolidate the migration history into one file.
  const out = process.argv[3] || "supabase/database.sql";
  const result = supabase(["db", "dump", "--db-url", dbUrl(ref), "--schema", "public", "-f", out], {
    stdio: "inherit",
  });
  if (result.status === 0) console.log(`Wrote ${out} (project ${ref}).`);
  process.exit(result.status ?? 1);
} else if (command === "gen-types") {
  generateTypes(ref);
  process.exit(0);
} else if (command === "link") {
  // Optional: re-point the linked-project cache to .env.local's project (needs login).
  const result = supabase(["link", "--project-ref", ref], { stdio: "inherit" });
  process.exit(result.status ?? 1);
} else {
  fail("Usage: node scripts/supabase-cli.mjs <migrate|gen-types|link>");
}
