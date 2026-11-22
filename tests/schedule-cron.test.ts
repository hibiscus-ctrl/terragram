// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The SQL `npm run cron:schedule` sends to the shared project, pinned without
 * running it. Secrets and hosts below are synthetic placeholders.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// A plain .mjs ops script, deliberately untyped like its peers in scripts/.
import {
  JOBS,
  PREFLIGHT_SQL,
  productColumnReady,
  scheduleSql,
  VAULT_SECRET_NAME,
} from "../scripts/schedule-cron.mjs";

const SECRET = "test-jobs-drain-secret-000000001";
const sql = scheduleSql({ siteUrl: "https://app.terragram.test", secret: SECRET });

/** The command pg_cron stores verbatim in `cron.job` for one job. */
function commandOf(jobName: string): string {
  const start = sql.indexOf(`select cron.schedule('${jobName}'`);
  assert.ok(start >= 0, `${jobName} is not scheduled`);
  const open = sql.indexOf("$cron$", start);
  return sql.slice(open, sql.indexOf("$cron$", open + "$cron$".length));
}

const VAULT_HEADER =
  /'x-jobs-secret', \(select decrypted_secret from vault\.decrypted_secrets where name = 'terragram_jobs_drain_secret'\)/;

describe("cron:schedule SQL", () => {
  it("schedules exactly the terragram-named jobs", () => {
    assert.deepEqual(
      JOBS.map((job: { name: string }) => job.name),
      ["terragram-flush-usage", "terragram-reconcile-managed"],
    );
    assert.equal(sql.match(/select cron\.schedule\(/g)?.length, JOBS.length);
  });

  it("schedules the flush every 15 minutes against the deployed route", () => {
    assert.match(sql, /select cron\.schedule\('terragram-flush-usage', '\*\/15 \* \* \* \*', \$cron\$/);
    const command = commandOf("terragram-flush-usage");
    assert.match(command, /url\s+:= 'https:\/\/app\.terragram\.test\/api\/jobs\/flush-usage'/);
    assert.match(command, VAULT_HEADER);
  });

  it("schedules the mint reconciliation every 6 hours against the deployed route", () => {
    assert.match(sql, /select cron\.schedule\('terragram-reconcile-managed', '25 \*\/6 \* \* \*', \$cron\$/);
    const command = commandOf("terragram-reconcile-managed");
    assert.match(command, /url\s+:= 'https:\/\/app\.terragram\.test\/api\/jobs\/reconcile-managed'/);
    assert.match(command, VAULT_HEADER);
  });

  it("is idempotent: replaces each job and upserts the secret instead of duplicating either", () => {
    for (const { name } of JOBS as { name: string }[]) {
      const unschedule = sql.indexOf(`cron.unschedule(jobid) from cron.job where jobname = '${name}'`);
      assert.ok(unschedule >= 0, `${name} is never unscheduled`);
      assert.ok(
        unschedule < sql.indexOf(`cron.schedule('${name}'`),
        `the old ${name} must be removed before the new one is scheduled`,
      );
    }
    assert.match(sql, /vault\.update_secret\(id, '[^']+'\) from vault\.secrets where name = 'terragram_jobs_drain_secret'/);
    assert.match(sql, /vault\.create_secret\('[^']+', 'terragram_jobs_drain_secret'\)\s+where not exists/);
    assert.equal(sql.match(/vault\.create_secret\(/g)?.length, 1, "one secret shared by every job");
  });

  it("keeps the secret out of every stored cron command", () => {
    // `cron.job` is readable by anyone with SQL access; Vault is where the secret lives.
    assert.ok(sql.includes(SECRET), "the secret is written to Vault");
    for (const { name } of JOBS as { name: string }[]) {
      assert.ok(!commandOf(name).includes(SECRET), `the secret leaked into ${name}'s command`);
    }
  });

  it("names its Vault secret apart from Infraweaver's in the shared project", () => {
    assert.equal(VAULT_SECRET_NAME, "terragram_jobs_drain_secret");
  });

  it("quotes a secret containing a quote instead of breaking out of the literal", () => {
    const quoted = scheduleSql({ siteUrl: "https://app.terragram.test", secret: "it's-a-long-secret-0001" });
    assert.ok(quoted.includes("'it''s-a-long-secret-0001'"));
  });

  it("refuses input the cron could never use", () => {
    for (const siteUrl of ["", "http://localhost:3000", "not a url"]) {
      assert.throws(() => scheduleSql({ siteUrl, secret: SECRET }), /SITE_URL/, siteUrl);
    }
    for (const secret of ["", "too-short"]) {
      assert.throws(() => scheduleSql({ siteUrl: "https://app.terragram.test", secret }), /JOBS_DRAIN_SECRET/);
    }
  });
});

describe("cron:schedule preflight", () => {
  it("refuses until the shared product column exists", () => {
    assert.match(PREFLIGHT_SQL, /table_name = 'usage_events' and column_name = 'product'/);
    assert.equal(productColumnReady(JSON.stringify([{ ready: true }])), true);
    assert.equal(productColumnReady(JSON.stringify([{ ready: false }])), false);
    assert.equal(productColumnReady("[]"), false);
  });
});
