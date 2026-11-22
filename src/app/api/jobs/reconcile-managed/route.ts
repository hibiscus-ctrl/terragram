import { requireJobsSecret } from "@/features/api/jobs-secret";
import { apiJson } from "@/features/api/responses";
import { withRouteErrors } from "@/features/api/route-errors";
import { makeReconcileManaged } from "@/features/billing/managed-reconcile-core";
import { reconcileManagedMints } from "@/features/billing/managed-usage";
import { logger } from "@/libs/log";

const log = logger("jobs/reconcile-managed");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reconcileManaged = makeReconcileManaged({
  reconcileManagedMints,
  warn: (message, meta) => log.warn(message, meta),
});

/**
 * POST /api/jobs/reconcile-managed — the managed-spend reconciliation tick. Flags
 * orgs whose `tmpx_` tokens were minted but never reported usage in the last 24h
 * (the decision lives in `managed-reconcile-core.ts`). Not user-facing: Supabase
 * `pg_cron` + `pg_net` pokes it every 6 hours (the `terragram-reconcile-managed`
 * job, see DEPLOY.md), authenticated by `JOBS_DRAIN_SECRET` sent as
 * `x-jobs-secret`. Read-only: it logs, it never corrects the ledger.
 *
 * Reconciling against actual Bedrock consumption (a CUR export) needs AWS billing
 * access and stays an ops task; this catches the silent-gateway half without it.
 */
async function handlePost(request: Request) {
  const refused = await requireJobsSecret(request, {
    label: "jobs/reconcile-managed",
    disables: "the reconcile endpoint",
    key: "jobs-reconcile",
    limit: 60,
  });
  if (refused) return refused;

  return apiJson(await reconcileManaged());
}

export const POST = withRouteErrors(handlePost);
