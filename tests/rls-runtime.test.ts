// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime proof that Postgres ENFORCES per-user isolation on Terragram's tables.
 *
 * `rls-isolation.test.ts` proves the migration DECLARES a complete posture; it
 * cannot prove enforcement. This suite seeds two users with one row in every
 * `terragram_*` table each, impersonates one of them, and asserts the database
 * itself refuses to show or change the other's rows.
 *
 * SAFETY: every scenario runs inside a single `begin … rollback`, so nothing is
 * ever committed — not the probe users, not their rows. The last test asserts
 * that rather than assuming it. Reads of pre-existing data are counts only. The
 * probe touches `auth.users` (rolled back) and `terragram_*` rows only; the
 * Infraweaver base trigger on `auth.users` runs and is rolled back with it.
 *
 * SKIPPED BY DEFAULT. `npm test` does not load `.env.local`, so this is inert in
 * CI and in normal local runs. Run it deliberately, against a project you are
 * allowed to probe:
 *
 *     npm run test:rls
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { declaredTables, migrationSql } from "./helpers/schema-policies.ts";

const CONFIGURED = Boolean(
  process.env.SUPABASE_ACCESS_TOKEN && process.env.NEXT_PUBLIC_SUPABASE_URL,
);

/** Fixed ids so a failed run leaves an obvious, greppable fingerprint — though a
 *  rollback means it should never reach disk at all. */
const A = {
  user: "aaaaaaaa-0000-4000-8000-0000000000a1",
  ws: "aaaaaaaa-0000-4000-8000-0000000000a2",
  snap: "aaaaaaaa-0000-4000-8000-0000000000a3",
  bundle: "aaaaaaaa-0000-4000-8000-0000000000a4",
  link: "aaaaaaaa-0000-4000-8000-0000000000a5",
  git: "aaaaaaaa-0000-4000-8000-0000000000a6",
};
const B = {
  user: "bbbbbbbb-0000-4000-8000-0000000000b1",
  ws: "bbbbbbbb-0000-4000-8000-0000000000b2",
  snap: "bbbbbbbb-0000-4000-8000-0000000000b3",
  bundle: "bbbbbbbb-0000-4000-8000-0000000000b4",
  link: "bbbbbbbb-0000-4000-8000-0000000000b5",
  git: "bbbbbbbb-0000-4000-8000-0000000000b6",
};
/** Signed in, but owns nothing. */
const OUTSIDER = "cccccccc-0000-4000-8000-0000000000c1";

function seedUser(u: typeof A, tag: string): string {
  return `
insert into public.terragram_workspaces (id, user_id, name) values ('${u.ws}', '${u.user}', 'rls-probe-${tag}');
insert into public.terragram_workspace_snapshots (id, workspace_id, model) values ('${u.snap}', '${u.ws}', '{}');
insert into public.terragram_evidence_bundles
  (id, workspace_id, user_id, content_hash, engine, cloud, approver, approved_at, model, plan)
  values ('${u.bundle}', '${u.ws}', '${u.user}', 'sha256:rls-probe-${tag}', 'deterministic', 'azure',
          'rls-probe-${tag}@example.invalid', now(), '{}', '{}');
insert into public.terragram_share_links (id, workspace_id, created_by, token_hash, expires_at)
  values ('${u.link}', '${u.ws}', '${u.user}', 'rls-probe-${tag}-hash', now() + interval '1 day');
insert into public.terragram_user_settings (user_id, settings) values ('${u.user}', '{}');
insert into public.terragram_git_connections (id, user_id, provider, account_login, access_token)
  values ('${u.git}', '${u.user}', 'github', 'rls-probe-${tag}', 'sealed-probe-value');
`;
}

/** Two users with one row in every terragram table each. Runs as the privileged
 *  API role, before any impersonation. */
const SEED = `
insert into auth.users (id, email) values
  ('${A.user}', 'rls-probe-terragram-a@example.invalid'),
  ('${B.user}', 'rls-probe-terragram-b@example.invalid'),
  ('${OUTSIDER}', 'rls-probe-terragram-outsider@example.invalid');
${seedUser(A, "a")}
${seedUser(B, "b")}
`;

/** Become `authenticated` carrying this user's JWT subject — the two settings
 *  `auth.uid()` reads. */
function becomeUser(userId: string): string {
  return `
set local role authenticated;
set local request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';
`;
}

/** Per table: the column that names the owner, for "own vs other" counts. The
 *  snapshot table is reached through its workspace. */
const OWNED: Record<string, (u: typeof A) => string> = {
  terragram_workspaces: (u) => `id = '${u.ws}'`,
  terragram_workspace_snapshots: (u) => `id = '${u.snap}'`,
  terragram_evidence_bundles: (u) => `id = '${u.bundle}'`,
  terragram_share_links: (u) => `id = '${u.link}'`,
  terragram_user_settings: (u) => `user_id = '${u.user}'`,
};
const SERVICE_ROLE_ONLY: Record<string, (u: typeof A) => string> = {
  terragram_git_connections: (u) => `id = '${u.git}'`,
};

let runSql: (query: string) => Promise<string>;

async function query(sql: string): Promise<Record<string, string | number>> {
  if (!runSql) ({ runSql } = await import("../scripts/supabase-query.mjs"));
  const rows = JSON.parse(await runSql(sql));
  assert.ok(Array.isArray(rows) && rows[0], `expected a result row from:\n${sql}`);
  return rows[0];
}

/** Run a write as `userId`; "refused" only when Postgres says RLS or a missing
 *  privilege stopped it — any other error is a broken probe, not a pass. */
async function attempt(userId: string, write: string): Promise<"ok" | "refused"> {
  try {
    await query(`
begin;
${SEED}
${becomeUser(userId)}
${write}
select 1 as done;
rollback;
`);
    return "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /row-level security|permission denied/, `probe failed for another reason:\n${message}`);
    return "refused";
  }
}

/** Rows a write touched, via a `returning` CTE — RLS hides a foreign row from
 *  UPDATE/DELETE silently, so the count is the signal, not an error. */
async function affected(userId: string, write: string): Promise<number> {
  const row = await query(`
begin;
${SEED}
${becomeUser(userId)}
with w as (${write} returning 1) select count(*) as n from w;
rollback;
`);
  return n(row.n);
}

/** Numeric coercion — the Management API returns counts as strings or numbers. */
function n(value: string | number | undefined): number {
  return Number(value ?? Number.NaN);
}

const counts = (who: typeof A, tables: Record<string, (u: typeof A) => string>, tag: string) =>
  Object.entries(tables)
    .map(([t, where]) => `(select count(*) from public.${t} where ${where(who)}) as ${tag}_${t}`)
    .join(",\n  ");

describe(
  "terragram RLS enforcement (live database)",
  {
    skip: CONFIGURED
      ? false
      : "needs SUPABASE_ACCESS_TOKEN + NEXT_PUBLIC_SUPABASE_URL — run `npm run test:rls`",
  },
  () => {
    for (const [me, other, label] of [
      [A, B, "A"],
      [B, A, "B"],
    ] as const) {
      it(`user ${label} reads their own rows and none of the other user's`, async () => {
        const row = await query(`
begin;
${SEED}
${becomeUser(me.user)}
select
  (select auth.uid()::text) as acting_as,
  ${counts(me, OWNED, "own")},
  ${counts(other, OWNED, "other")};
rollback;
`);
        // The positive control: without it every "0 rows" below would also pass
        // against impersonation that silently failed.
        assert.equal(row.acting_as, me.user, "impersonation did not take effect");
        for (const t of Object.keys(OWNED)) {
          assert.equal(n(row[`own_${t}`]), 1, `${label} cannot see their own ${t} row`);
          assert.equal(n(row[`other_${t}`]), 0, `LEAK: ${label} can see the other user's ${t} row`);
        }
      });
    }

    it("hides the service-role-only tables even from their owner", async () => {
      const row = await query(`
begin;
${SEED}
${becomeUser(A.user)}
select
  ${counts(A, SERVICE_ROLE_ONLY, "own")},
  ${counts(B, SERVICE_ROLE_ONLY, "other")};
rollback;
`);
      for (const t of Object.keys(SERVICE_ROLE_ONLY)) {
        assert.equal(n(row[`own_${t}`]), 0, `${t} is readable by a client — sealed tokens included`);
        assert.equal(n(row[`other_${t}`]), 0, `LEAK: ${t} of another user is readable`);
      }
    });

    it("shows a signed-in user who owns nothing, and an anonymous caller, nothing at all", async () => {
      const tables = declaredTables(migrationSql());
      assert.ok(tables.length >= 6, `expected every terragram table, got ${tables.length}`);
      const visible = tables.map((t) => `(select count(*) from public.${t}) as ${t}`).join(",\n  ");
      for (const as of [becomeUser(OUTSIDER), "set local role anon;"]) {
        const row = await query(`
begin;
${SEED}
${as}
select
  ${visible};
rollback;
`).catch((error: unknown) => {
          // anon holds no grant on these tables, which is a refusal too.
          assert.match(String(error), /permission denied/);
          return null;
        });
        if (!row) continue;
        for (const t of tables) {
          assert.equal(n(row[t]), 0, `LEAK: ${t} rows visible to ${as.includes("anon") ? "anon" : "a non-owner"}`);
        }
      }
    });

    it("lets a user write their OWN rows (positive control for the refusals below)", async () => {
      // Without this, the refusals could be a missing grant or a broken probe
      // rather than the policy doing its job.
      assert.equal(
        await attempt(A.user, `insert into public.terragram_workspace_snapshots (workspace_id, model) values ('${A.ws}', '{}');`),
        "ok",
      );
      assert.equal(await affected(A.user, `update public.terragram_workspaces set name = 'renamed' where id = '${A.ws}'`), 1);
    });

    it("refuses to change or delete another user's rows", async () => {
      assert.equal(await affected(A.user, `update public.terragram_workspaces set name = 'pwned' where id = '${B.ws}'`), 0);
      assert.equal(await affected(A.user, `delete from public.terragram_workspaces where id = '${B.ws}'`), 0);
      assert.equal(await affected(A.user, `delete from public.terragram_workspace_snapshots where id = '${B.snap}'`), 0);
      assert.equal(await affected(A.user, `update public.terragram_evidence_bundles set approver = 'pwned' where id = '${B.bundle}'`), 0);
      assert.equal(await affected(A.user, `update public.terragram_share_links set revoked_at = null, expires_at = now() + interval '10 years' where id = '${B.link}'`), 0);
      assert.equal(await affected(A.user, `update public.terragram_user_settings set settings = '{"pwned":true}' where user_id = '${B.user}'`), 0);
      assert.equal(await affected(A.user, `delete from public.terragram_git_connections where id = '${B.git}'`), 0);
    });

    it("refuses rows written in another user's name", async () => {
      assert.equal(
        await attempt(A.user, `insert into public.terragram_workspaces (user_id, name) values ('${B.user}', 'planted');`),
        "refused",
      );
      assert.equal(
        await attempt(A.user, `insert into public.terragram_user_settings (user_id) values ('${OUTSIDER}');`),
        "refused",
      );
      assert.equal(
        await attempt(A.user, `insert into public.terragram_git_connections (user_id, provider, account_login, access_token) values ('${A.user}', 'gitlab', 'x', 'y');`),
        "refused",
      );
    });

    it("refuses a snapshot planted into another user's workspace", async () => {
      assert.equal(
        await attempt(A.user, `insert into public.terragram_workspace_snapshots (workspace_id, model) values ('${B.ws}', '{}');`),
        "refused",
      );
    });

    it("refuses a share link or evidence bundle pointing at another user's workspace", async () => {
      // Both policies once checked only their own owner column, never
      // `workspace_id`. A share link planted that way opened B's workspace to
      // whoever held the token A chose, and B could neither see nor revoke it.
      // See rls-isolation.test.ts.
      assert.equal(
        await attempt(
          A.user,
          `insert into public.terragram_share_links (workspace_id, created_by, token_hash, expires_at) values ('${B.ws}', '${A.user}', 'rls-probe-planted', now() + interval '10 years');`,
        ),
        "refused",
        "LEAK: a user can mint a share link for another user's workspace",
      );
      assert.equal(
        await attempt(
          A.user,
          `insert into public.terragram_evidence_bundles (workspace_id, user_id, content_hash, engine, cloud, approver, approved_at, model, plan) values ('${B.ws}', '${A.user}', 'sha256:planted', 'deterministic', 'azure', 'x', now(), '{}', '{}');`,
        ),
        "refused",
        "a user can file evidence against another user's workspace",
      );
    });

    it("leaves no trace behind (the rollback is real)", async () => {
      // Runs last, so it also covers every scenario above.
      const row = await query(`
select
  (select count(*) from auth.users where email like 'rls-probe-terragram-%') as users,
  (select count(*) from public.terragram_workspaces where name like 'rls-probe-%' or name = 'planted') as workspaces;
`);
      assert.equal(n(row.users), 0, "probe users were COMMITTED to the live database");
      assert.equal(n(row.workspaces), 0, "probe workspaces were COMMITTED to the live database");
    });
  },
);
