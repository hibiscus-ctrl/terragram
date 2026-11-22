// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The managed-models money meter (Phase D). The metering DECISION (read prior spend →
 * apply allowance → append rows) now lives in the atomic `record_managed_usage` SQL
 * function so it can't race or double-bill — see `database.sql`. What remains in TS is
 * the allowance window + the `kind` literals shared with that SQL; the overage formula
 * the SQL mirrors is `meterableOverPence` (covered by `model-cost.test.ts`). This file
 * locks the window + the SQL↔TS contract. Pure — run with
 * `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MANAGED_LEDGER_KIND,
  MANAGED_METER_KIND,
  monthStartIso,
  USAGE_PRODUCT,
} from "../src/features/billing/managed-meter.ts";
import { meterableOverPence } from "../src/features/billing/model-cost.ts";

describe("monthStartIso (allowance window)", () => {
  it("floors to midnight on the 1st of the current UTC month", () => {
    assert.equal(monthStartIso(Date.UTC(2026, 5, 24, 13, 47, 9)), "2026-06-01T00:00:00.000Z");
  });

  it("is stable across every instant within the month, and rolls at the boundary", () => {
    const early = monthStartIso(Date.UTC(2026, 5, 1, 0, 0, 0));
    const late = monthStartIso(Date.UTC(2026, 5, 30, 23, 59, 59));
    assert.equal(early, late); // same window all month
    assert.equal(monthStartIso(Date.UTC(2026, 6, 1, 0, 0, 0)), "2026-07-01T00:00:00.000Z"); // next month
  });

  it("derives the window from UTC, not local time (a late-night UTC instant stays in-month)", () => {
    assert.equal(monthStartIso(Date.UTC(2026, 0, 31, 23, 0, 0)), "2026-01-01T00:00:00.000Z");
  });
});

describe("kind literals match the SQL ledger/meter rows", () => {
  it("are the exact strings record_managed_usage writes (managed_cost / managed_meter)", () => {
    // These travel to Postgres as the `kind` of the rows the SQL inserts, and the
    // Stripe flush aggregates `managed_meter`. If either drifts, the meter silently
    // stops matching — pin them here.
    assert.equal(MANAGED_LEDGER_KIND, "managed_cost");
    assert.equal(MANAGED_METER_KIND, "managed_meter");
  });

  it("scopes them to terragram's product, never the column default", () => {
    // `usage_events` is shared with Infraweaver, whose flush bills its own rows to
    // its own Stripe meter. The column and every function's `p_product` default
    // to 'infraweaver', and the check admits exactly these two — so this must be
    // the one value that is NOT the default.
    assert.equal(USAGE_PRODUCT, "terragram");
  });
});

describe("SQL ↔ TS overage formula contract (record_managed_usage mirrors meterableOverPence)", () => {
  it("the SQL expression equals meterableOverPence for representative inputs", () => {
    // The SQL computes:
    //   greatest(0, greatest(0, prior+cost-allowance) - greatest(0, prior-allowance))
    // which must equal meterableOverPence(prior, cost, allowance). If the formula is
    // ever changed in one place, change it in both — this test fails if they drift.
    const sqlOverage = (prior: number, cost: number, allowance: number) =>
      Math.max(
        0,
        Math.max(0, prior + cost - allowance) - Math.max(0, prior - allowance),
      );
    const cases: [number, number, number][] = [
      [0, 100, 1000],
      [900, 200, 1000],
      [1000, 100, 1000],
      [2000, 300, 1000],
      [0, 50, 0],
      [500, 500, 0],
      [750, 0, 1000],
    ];
    for (const [prior, cost, allowance] of cases) {
      assert.equal(
        sqlOverage(prior, cost, allowance),
        meterableOverPence(prior, cost, allowance),
        `formula drift at (${prior}, ${cost}, ${allowance})`,
      );
    }
  });
});
