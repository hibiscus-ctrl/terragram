/**
 * The managed-spend reconciliation tick, behind injected collaborators so it is
 * unit-testable without a database. `/api/jobs/reconcile-managed` binds the
 * adapters.
 *
 * Metering is callback-after-the-fact: the gateway spends on Bedrock FIRST and
 * reports to `/api/proxy-usage` second, so a gateway bug, outage or deploy skew is
 * real AWS spend that never lands in the ledger and is never billed. Every token
 * mint writes a `managed_mint` row; this compares mints against usage reports per
 * org over a window and flags any org with mints but zero reports, the one drift
 * this side of the AWS bill can see. Read-only: it flags, it never corrects the
 * ledger.
 */

/** Per-org `managed_mint` vs `managed_cost` counts over the window. */
export type MintReconciliationRow = {
  orgId: string;
  mints: number;
  usageReports: number;
};

/** Default look-back. Longer than the 1h token TTL plus a generous gateway-report
 *  lag, short enough that an alert is actionable while logs still exist. */
export const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;

export type ReconcileManagedDeps = {
  /** The DB-aggregated reconciliation read; throws on a read error. */
  reconcileManagedMints: (windowMs: number) => Promise<MintReconciliationRow[]>;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

export function makeReconcileManaged(deps: ReconcileManagedDeps) {
  return async function reconcileManaged() {
    const rows = await deps.reconcileManagedMints(RECONCILE_WINDOW_MS);
    const silent = rows.filter((r) => r.mints > 0 && r.usageReports === 0);
    for (const r of silent) {
      // A mint without usage is not proof of loss (the call may have failed before
      // the gateway spent anything) — it is the signal to check the gateway's own logs.
      deps.warn("proxy tokens minted with zero usage reports — check the gateway", {
        orgId: r.orgId,
        mints: r.mints,
      });
    }
    return {
      ok: true as const,
      orgs: rows.length,
      silent: silent.map((r) => ({ orgId: r.orgId, mints: r.mints })),
    };
  };
}
