// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The managed-models entitlement gate, as a pure predicate (no I/O, no `@/` imports —
 * so it's unit-testable under the node `--test` harness and importable from anywhere).
 *
 * This is the SINGLE definition of "is this org allowed to use managed models right
 * now": it's on the `payg` plan AND has not opted out. The mint route
 * (`/api/proxy-token`) checks the same two conditions (splitting them so it can return
 * 402 vs 501); the metering re-check (`recordManagedUsage`) uses this directly so
 * the two boundaries can never silently disagree.
 */
export function managedEntitled(org: {
  plan: string | null;
  managed_opt_out: boolean | null;
}): boolean {
  return org.plan === "payg" && !org.managed_opt_out;
}
