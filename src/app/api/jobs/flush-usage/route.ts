// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { requireJobsSecret } from "@/features/api/jobs-secret";
import { apiJson } from "@/features/api/responses";
import { withRouteErrors } from "@/features/api/route-errors";
import { flushAllPendingUsage } from "@/features/billing/metering";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/jobs/flush-usage — push the unreported managed-usage backlog to the
 * Stripe money meter. Not user-facing: Supabase `pg_cron` + `pg_net` pokes it
 * every 15 minutes (the `terragram-flush-usage` job, see DEPLOY.md),
 * authenticated by `JOBS_DRAIN_SECRET` sent as `x-jobs-secret`.
 *
 * Without it, usage reached Stripe only at the `subscription.updated` renewal or
 * on a billing-page view, so managed spend landed a cycle in arrears. Idempotent:
 * each `managed_meter` row reports exactly once (the meter identifier is the row
 * id), so overlapping ticks never double-bill.
 */
async function handlePost(request: Request) {
  const refused = await requireJobsSecret(request, {
    label: "jobs/flush-usage",
    disables: "the usage-flush endpoint",
    key: "jobs-flush",
    limit: 60,
  });
  if (refused) return refused;

  const result = await flushAllPendingUsage();
  return apiJson({ ok: true, ...result });
}

export const POST = withRouteErrors(handlePost);
