// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dogfood-gate report: the merge-without-edit rate from the live `outcomes` table
 * (the 6.20 human-edit capture). Prints whether the P1 gate (≥80% over a real
 * sample) is met. The "sustained over two consecutive weeks" part is operational —
 * run this on a cadence and watch the trend.
 *
 * Usage (loads .env.local first):
 *   npm run dogfood:metrics                 # all time
 *   npm run dogfood:metrics -- --since 2026-06-01
 *   npm run dogfood:metrics -- --days 14    # the last 14 days (the gate window)
 */
import { projectRef, runSql } from "./supabase-query.mjs";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const days = flag("--days");
const since =
  flag("--since") ?? (days ? `now() - interval '${Number.parseInt(days, 10) || 14} days'` : null);
const THRESHOLD = 0.8;
const MIN_SAMPLE = 5;

const where = since
  ? `where created_at >= ${/^\d{4}-\d{2}-\d{2}$/.test(since) ? `'${since}'` : since}`
  : "";

try {
  const body = await runSql(
    `select outcome, count(*)::int as n from public.outcomes ${where} group by outcome;`,
  );
  const rows = JSON.parse(body);
  const counts = { merged_clean: 0, merged_with_edits: 0, rejected: 0 };
  for (const r of rows) {
    if (r.outcome in counts) counts[r.outcome] = r.n;
  }
  const merged = counts.merged_clean + counts.merged_with_edits;
  const rate = merged > 0 ? counts.merged_clean / merged : null;
  const gateMet = rate !== null && rate >= THRESHOLD && merged >= MIN_SAMPLE;
  const pct = rate === null ? "n/a" : `${Math.round(rate * 100)}%`;

  console.log(`Dogfood gate (project ${projectRef()})${since ? ` since ${since}` : ""}:`);
  console.log(`  merged clean       : ${counts.merged_clean}`);
  console.log(`  merged with edits  : ${counts.merged_with_edits}`);
  console.log(`  rejected           : ${counts.rejected}`);
  console.log(`  merge-without-edit : ${pct}  (${counts.merged_clean}/${merged} merged)`);
  console.log(
    `  GATE (≥${Math.round(THRESHOLD * 100)}%, ≥${MIN_SAMPLE} merged): ${
      gateMet
        ? "MET ✅"
        : merged < MIN_SAMPLE
          ? `not enough data (${merged}/${MIN_SAMPLE})`
          : "NOT met ❌"
    }`,
  );
  process.exit(gateMet ? 0 : 1);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
