// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the prepaid-credit helpers (amount validation + Stripe balance →
 * available credit). Pure — run with `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  availableCreditPence,
  MAX_TOPUP_PENCE,
  MIN_TOPUP_PENCE,
  normalizeTopupPence,
} from "../src/features/billing/credit.ts";

describe("normalizeTopupPence", () => {
  it("accepts whole-penny amounts within bounds", () => {
    assert.equal(normalizeTopupPence(2500), 2500);
    assert.equal(normalizeTopupPence(MIN_TOPUP_PENCE), MIN_TOPUP_PENCE);
    assert.equal(normalizeTopupPence(MAX_TOPUP_PENCE), MAX_TOPUP_PENCE);
  });

  it("rounds fractional pence to the nearest whole", () => {
    assert.equal(normalizeTopupPence(2500.4), 2500);
    assert.equal(normalizeTopupPence(2500.6), 2501);
  });

  it("coerces numeric strings", () => {
    assert.equal(normalizeTopupPence("5000"), 5000);
  });

  it("rejects out-of-range, non-finite and junk input", () => {
    assert.equal(normalizeTopupPence(MIN_TOPUP_PENCE - 1), null);
    assert.equal(normalizeTopupPence(MAX_TOPUP_PENCE + 1), null);
    assert.equal(normalizeTopupPence(0), null);
    assert.equal(normalizeTopupPence(-2500), null);
    assert.equal(normalizeTopupPence(Number.NaN), null);
    assert.equal(normalizeTopupPence("abc"), null);
    assert.equal(normalizeTopupPence(null), null);
  });
});

describe("availableCreditPence", () => {
  it("treats a negative Stripe balance as available credit", () => {
    assert.equal(availableCreditPence(-5000), 5000);
  });

  it("is zero for a zero, positive (amount owed) or missing balance", () => {
    assert.equal(availableCreditPence(0), 0);
    assert.equal(availableCreditPence(3000), 0);
    assert.equal(availableCreditPence(null), 0);
    assert.equal(availableCreditPence(undefined), 0);
  });
});
