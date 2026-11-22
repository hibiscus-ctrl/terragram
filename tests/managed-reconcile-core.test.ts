/**
 * The managed-spend reconciliation tick (`/api/jobs/reconcile-managed`): which
 * orgs it flags, over which window, and that a failed read surfaces rather than
 * reporting a clean sweep. The HTTP half (the jobs-secret gate) is
 * `tests/api/jobs.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  makeReconcileManaged,
  type MintReconciliationRow,
  RECONCILE_WINDOW_MS,
} from "../src/features/billing/managed-reconcile-core.ts";

function harness(rows: MintReconciliationRow[] | Error) {
  const windows: number[] = [];
  const warnings: { message: string; meta: Record<string, unknown> }[] = [];
  const reconcile = makeReconcileManaged({
    reconcileManagedMints: async (windowMs) => {
      windows.push(windowMs);
      if (rows instanceof Error) throw rows;
      return rows;
    },
    warn: (message, meta) => warnings.push({ message, meta }),
  });
  return { reconcile, windows, warnings };
}

describe("managed mint reconciliation", () => {
  it("flags only orgs with mints and zero usage reports", async () => {
    const { reconcile, warnings } = harness([
      { orgId: "org-silent", mints: 3, usageReports: 0 },
      { orgId: "org-healthy", mints: 2, usageReports: 5 },
      { orgId: "org-reports-only", mints: 0, usageReports: 1 },
    ]);

    const result = await reconcile();

    assert.deepEqual(result, { ok: true, orgs: 3, silent: [{ orgId: "org-silent", mints: 3 }] });
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0]?.meta, { orgId: "org-silent", mints: 3 });
    assert.match(warnings[0]?.message ?? "", /check the gateway/);
  });

  it("reports a clean sweep when every minting org reported usage", async () => {
    const { reconcile, warnings } = harness([{ orgId: "org-1", mints: 1, usageReports: 1 }]);
    assert.deepEqual(await reconcile(), { ok: true, orgs: 1, silent: [] });
    assert.equal(warnings.length, 0);
  });

  it("looks back 24 hours, past the 1h token TTL plus gateway-report lag", async () => {
    const { reconcile, windows } = harness([]);
    await reconcile();
    assert.equal(RECONCILE_WINDOW_MS, 24 * 60 * 60 * 1000);
    assert.deepEqual(windows, [RECONCILE_WINDOW_MS]);
  });

  it("propagates a failed read instead of reporting nothing silent", async () => {
    // An unreadable ledger is not a clean bill of health: the route's error
    // boundary turns this into a 500 the scheduler's run log shows.
    const { reconcile, warnings } = harness(new Error("managed mint reconciliation failed: boom"));
    await assert.rejects(reconcile(), /reconciliation failed/);
    assert.equal(warnings.length, 0);
  });
});
