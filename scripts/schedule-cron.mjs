// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Schedule Terragram's background jobs in the LIVE Supabase project's pg_cron,
 * through the same Management API path as `db:exec`. Idempotent: re-running
 * updates the stored secret and replaces the jobs, so it is also how the secret is
 * rotated and the URL changed.
 *
 *   SITE_URL=https://<deployed-host> JOBS_DRAIN_SECRET=<the Railway value> npm run cron:schedule
 *
 * SITE_URL (else NEXT_PUBLIC_SITE_URL) is the deployed https origin pg_net POSTs
 * to; JOBS_DRAIN_SECRET must equal the value set on the Railway service. The npm
 * script loads .env.local WITHOUT overriding the shell, so values given on the
 * command line win over local-dev ones, and SUPABASE_ACCESS_TOKEN still comes from
 * .env.local like every db:* script.
 *
 * Shared project, so everything here is named `terragram`: the cron jobs, and the
 * Vault secret they read at run time. The secret goes to Vault rather than into a
 * job's command because `cron.job` stores commands verbatim, readable by anyone
 * with SQL access. pg_cron and pg_net are the shared project's extensions
 * (Infraweaver's jobs run on them); this does not create them.
 */
import { projectRef, runSql } from "./supabase-query.mjs";

/**
 * Each job is a pg_cron entry that POSTs one `/api/jobs/*` route. The usage flush
 * runs every 15 minutes so managed spend reaches Stripe within the cycle. The
 * read-only mint reconciliation runs every 6 hours, Infraweaver's cadence for the
 * same tick, at :25 so it never lands on a flush.
 */
export const JOBS = [
  { name: "terragram-flush-usage", schedule: "*/15 * * * *", path: "/api/jobs/flush-usage" },
  {
    name: "terragram-reconcile-managed",
    schedule: "25 */6 * * *",
    path: "/api/jobs/reconcile-managed",
  },
];
export const VAULT_SECRET_NAME = "terragram_jobs_drain_secret";

/** `requireJobsSecret` refuses a shorter secret, answering 401 to its own cron. */
const MIN_SECRET_LENGTH = 16;

/**
 * The shared `usage_events.product` column (added by infraweaver-ui's migration)
 * is what keeps these jobs to terragram's own rows. Scheduling before it exists
 * would run jobs whose every query fails, so the script checks first.
 */
export const PREFLIGHT_SQL =
  "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'usage_events' and column_name = 'product') as ready";

/** Read the preflight answer from the Management API's JSON rows. */
export function productColumnReady(body) {
  const rows = JSON.parse(body);
  return Array.isArray(rows) && rows[0]?.ready === true;
}

/** A SQL string literal. */
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * The SQL that (re)schedules every job in `JOBS`. Pure, so a test can pin it.
 * Throws on input the cron could never use.
 */
export function scheduleSql({ siteUrl, secret }) {
  const origin = URL.canParse(siteUrl) ? new URL(siteUrl) : null;
  if (origin?.protocol !== "https:") {
    throw new Error(`SITE_URL must be the deployed https origin pg_net can reach, got "${siteUrl}"`);
  }
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JOBS_DRAIN_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`);
  }
  const name = literal(VAULT_SECRET_NAME);

  const jobs = JOBS.map(
    (job) => `
select cron.unschedule(jobid) from cron.job where jobname = ${literal(job.name)};
select cron.schedule(${literal(job.name)}, ${literal(job.schedule)}, $cron$
  select net.http_post(
    url     := ${literal(new URL(job.path, origin).href)},
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-jobs-secret', (select decrypted_secret from vault.decrypted_secrets where name = ${name})
    ),
    timeout_milliseconds := 20000
  );
$cron$);`,
  );

  return `
select vault.update_secret(id, ${literal(secret)}) from vault.secrets where name = ${name};
select vault.create_secret(${literal(secret)}, ${name})
  where not exists (select 1 from vault.secrets where name = ${name});
${jobs.join("\n")}
`.trim();
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    const sql = scheduleSql({
      siteUrl: process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "",
      // Exactly as the app reads it, so the two compare equal.
      secret: process.env.JOBS_DRAIN_SECRET ?? "",
    });
    if (!productColumnReady(await runSql(PREFLIGHT_SQL))) {
      throw new Error(
        "usage_events.product does not exist yet: apply infraweaver-ui's migration (npm run db:apply there) before scheduling the jobs.",
      );
    }
    await runSql(sql);
    for (const job of JOBS) {
      console.log(`OK (project ${projectRef()}): ${job.name} scheduled '${job.schedule}'.`);
    }
    const names = JOBS.map((job) => `'${job.name}'`).join(", ");
    console.log(
      `Check: select j.jobname, d.status, d.start_time from cron.job_run_details d join cron.job j using (jobid) where j.jobname in (${names}) order by d.start_time desc limit 10;`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
