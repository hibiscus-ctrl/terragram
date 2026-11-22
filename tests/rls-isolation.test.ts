/**
 * Tenant-isolation invariants over Terragram's migration.
 *
 * WHAT THIS PROVES: that the RLS posture declared in the migration is complete —
 * every table has RLS on, every table is deliberately classified as owner-scoped
 * or service-role-only, every client policy is keyed on the signed-in user's own
 * id, and the file touches nothing but `terragram_*` objects. The Supabase project
 * is shared with Infraweaver Cloud, so that last one is a tenancy property too: a
 * statement here that reaches a shared table changes another product's data.
 *
 * WHAT THIS DOES NOT PROVE: that Postgres enforces the policies at runtime. That
 * is `rls-runtime.test.ts`, which needs the live database (`npm run test:rls`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  columnsOf,
  declaredGrants,
  declaredPolicies,
  declaredTables,
  migrationSql,
  rlsEnabledTables,
} from "./helpers/schema-policies.ts";

const SQL = migrationSql();
const TABLES = declaredTables(SQL);
const RLS_ON = rlsEnabledTables(SQL);
const POLICIES = declaredPolicies(SQL);
const GRANTS = declaredGrants(SQL);

/**
 * Tables NO client may reach: RLS on and no policy at all, so only the service
 * role (which bypasses RLS) reads them. Git connections hold sealed OAuth tokens.
 */
const SERVICE_ROLE_ONLY = new Set(["terragram_git_connections"]);

/** The column each owner-scoped table names its owner by. A table reached only
 *  through its parent workspace is listed under `via-workspace`. */
const OWNER_COLUMN: Record<string, string> = {
  terragram_workspaces: "user_id",
  terragram_workspace_snapshots: "via-workspace",
  terragram_evidence_bundles: "user_id",
  terragram_share_links: "created_by",
  terragram_user_settings: "user_id",
};

/** Ownership resolved through the parent workspace. */
const OWNS_WORKSPACE =
  "exists \\(select 1 from terragram_workspaces w where w\\.id = workspace_id and w\\.user_id = \\(select auth\\.uid\\(\\)\\)\\)";
const VIA_WORKSPACE = new RegExp(`^${OWNS_WORKSPACE}$`);

/** `(select auth.uid()) = <col>` — the own-row shape, with the uid wrapped in a
 *  subselect so Postgres evaluates it once per statement, not once per row. A
 *  table that also names a workspace may AND on ownership of that workspace
 *  (optional when `workspace_id` is nullable). */
const ownRow = (column: string) =>
  new RegExp(
    `^\\(select auth\\.uid\\(\\)\\) = ${column}(?: and (?:${OWNS_WORKSPACE}|\\(workspace_id is null or ${OWNS_WORKSPACE}\\)))?$`,
  );

describe("the parser sees the schema", () => {
  it("finds every table we expect (it is not silently matching nothing)", () => {
    for (const t of [
      "terragram_workspaces",
      "terragram_workspace_snapshots",
      "terragram_evidence_bundles",
      "terragram_share_links",
      "terragram_user_settings",
      "terragram_git_connections",
    ]) {
      assert.ok(TABLES.includes(t), `expected table ${t}`);
    }
    assert.ok(POLICIES.length >= 8, `only parsed ${POLICIES.length} policies`);
  });
});

describe("the migration owns only terragram_* objects (the project is shared)", () => {
  it("creates only terragram_-prefixed tables", () => {
    const foreign = TABLES.filter((t) => !t.startsWith("terragram_"));
    assert.deepEqual(foreign, [], `tables outside the terragram_ prefix: ${foreign.join(", ")}`);
  });

  it("alters, indexes, grants and polices only terragram_ tables", () => {
    const targets = [
      ...[...SQL.matchAll(/^alter table (?:if exists )?(?:public\.)?(\w+)/gim)].map((m) => m[1]),
      ...[...SQL.matchAll(/^create (?:unique )?index (?:if not exists )?(\w+)/gim)].map((m) => m[1]),
      ...[...SQL.matchAll(/\bon (?:public\.)?(\w+)\s*\(/gi)].map((m) => m[1]),
      ...POLICIES.map((p) => p.table),
      ...GRANTS.map((g) => g.table),
      ...[...SQL.matchAll(/^drop policy if exists "[^"]+" on (?:public\.)?(\w+)/gim)].map((m) => m[1]),
    ].map(String);
    const foreign = [...new Set(targets.filter((t) => !t.startsWith("terragram_")))];
    assert.deepEqual(foreign, [], `statements reaching shared objects: ${foreign.join(", ")}`);
  });

  it("declares no functions, triggers, types or event triggers", () => {
    // Shared functions (`is_org_member`, `handle_new_user`, …) belong to the
    // Infraweaver base schema; a `create or replace` here would silently swap the
    // live body for this file's copy.
    for (const re of [
      /^create (?:or replace )?function/im,
      /^create (?:or replace )?trigger/im,
      /^create event trigger/im,
      /^create type/im,
      /^drop (?:table|function|trigger|type|schema)/im,
      /^truncate/im,
    ]) {
      assert.doesNotMatch(SQL, re);
    }
  });
});

describe("every table is under RLS", () => {
  it("enables row level security on EVERY table it creates", () => {
    const missing = TABLES.filter((t) => !RLS_ON.has(t));
    assert.deepEqual(missing, [], `tables created without RLS: ${missing.join(", ")}`);
  });

  it("classifies every table as owner-scoped or service-role-only", () => {
    const unclassified = TABLES.filter((t) => !(t in OWNER_COLUMN) && !SERVICE_ROLE_ONLY.has(t));
    assert.deepEqual(unclassified, [], `tables with no stated access intent: ${unclassified.join(", ")}`);
    const stale = Object.keys(OWNER_COLUMN).filter((t) => !TABLES.includes(t));
    assert.deepEqual(stale, [], `OWNER_COLUMN names tables that no longer exist: ${stale.join(", ")}`);
  });

  it("gives every owner-scoped table a read policy and a write policy", () => {
    for (const table of Object.keys(OWNER_COLUMN)) {
      const mine = POLICIES.filter((p) => p.table === table);
      assert.ok(
        mine.some((p) => p.command === "select" || p.command === "all"),
        `${table} has no read policy`,
      );
      assert.ok(mine.some((p) => p.command === "all"), `${table} has no write policy`);
    }
  });
});

describe("no client-facing policy can leak across users", () => {
  it("scopes every policy to authenticated — never unscoped, anon or public", () => {
    for (const p of POLICIES) {
      assert.deepEqual(p.roles, ["authenticated"], `${p.table}/"${p.name}" roles: ${p.roles.join(", ")}`);
    }
  });

  it("never uses an unconditional `using (true)`", () => {
    for (const p of POLICIES) {
      assert.notEqual(p.using.toLowerCase(), "true", `${p.table}/"${p.name}" returns every row`);
    }
  });

  it("keys every policy on the signed-in user's own id", () => {
    for (const p of POLICIES) {
      const column = OWNER_COLUMN[p.table];
      assert.ok(column, `${p.table}/"${p.name}" is a policy on an unclassified table`);
      const shape = column === "via-workspace" ? VIA_WORKSPACE : ownRow(column);
      assert.match(p.using, shape, `${p.table}/"${p.name}" using is not own-row scoped`);
    }
  });

  it("checks every write policy's NEW row the same way it filters the old one", () => {
    // `for all` without `with check` falls back to `using` for inserts in Postgres,
    // but spelling it out is what a reviewer reads — and a check that drifts from
    // the using clause lets a user insert a row they could then never see.
    for (const p of POLICIES.filter((x) => x.command === "all")) {
      assert.equal(p.check, p.using, `${p.table}/"${p.name}" with check differs from using`);
    }
  });

  it("gates every workspace-linked table on ownership of THAT workspace", () => {
    // Owning the row is not enough: a share link or receipt a user could write
    // against ANOTHER user's workspace (through PostgREST, with their own session)
    // would open that workspace to whoever holds a token they chose, and the real
    // owner could neither see nor revoke it. The runtime half is in
    // rls-runtime.test.ts.
    const linked = TABLES.filter((t) => columnsOf(SQL, t).includes("workspace_id"));
    for (const t of ["terragram_workspace_snapshots", "terragram_share_links", "terragram_evidence_bundles"]) {
      assert.ok(linked.includes(t), `expected ${t} to carry workspace_id`);
    }
    for (const table of linked) {
      const writes = POLICIES.filter((x) => x.table === table && x.command === "all");
      assert.ok(writes.length > 0, `${table} has no write policy to check`);
      for (const p of writes) {
        assert.match(
          p.check,
          new RegExp(OWNS_WORKSPACE),
          `${table}/"${p.name}" lets a user write a row for a workspace they do not own`,
        );
      }
    }
  });
});

describe("the service-role-only tables are unreachable from a client", () => {
  for (const table of SERVICE_ROLE_ONLY) {
    it(`${table} has no policy`, () => {
      assert.deepEqual(
        POLICIES.filter((p) => p.table === table).map((p) => p.name),
        [],
        `${table} must stay invisible to clients`,
      );
    });

    it(`${table} is granted to service_role only`, () => {
      const roles = GRANTS.filter((g) => g.table === table).flatMap((g) => g.roles);
      assert.ok(roles.length > 0, `${table} has no grant at all`);
      assert.deepEqual([...new Set(roles)], ["service_role"]);
    });
  }

  it("keeps the credential-bearing columns on a service-role-only table", () => {
    for (const table of TABLES.filter((t) => columnsOf(SQL, t).includes("access_token"))) {
      assert.ok(SERVICE_ROLE_ONLY.has(table), `${table} holds access_token but a client can reach it`);
    }
  });
});

describe("grants", () => {
  it("never grants anything to anon or public", () => {
    for (const g of GRANTS) {
      for (const role of g.roles) {
        assert.ok(!["anon", "public"].includes(role), `${g.table} is granted to ${role}`);
      }
    }
  });

  it("grants every owner-scoped table to the roles its policies name", () => {
    for (const table of Object.keys(OWNER_COLUMN)) {
      const roles = GRANTS.filter((g) => g.table === table).flatMap((g) => g.roles);
      assert.ok(roles.includes("authenticated"), `${table} is not granted to authenticated`);
      assert.ok(roles.includes("service_role"), `${table} is not granted to service_role`);
    }
  });
});
