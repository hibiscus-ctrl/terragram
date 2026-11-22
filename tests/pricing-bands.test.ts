// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the per-repo Team banding math (the price the calculator, the
 * billing page and the Stripe graduated tiers all derive from). Pure — run with
 * `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  annualSavingPercent,
  bandedTotalPence,
  entryRatePence,
  formatGbp,
  formatGbpAmount,
} from "../src/config/pricing.ts";

describe("bandedTotalPence (marginal / graduated)", () => {
  it("is £0 for zero or negative repos", () => {
    assert.equal(bandedTotalPence(0, "month"), 0);
    assert.equal(bandedTotalPence(-3, "month"), 0);
  });

  it("charges the entry band up to its ceiling", () => {
    assert.equal(bandedTotalPence(1, "month"), 2400);
    assert.equal(bandedTotalPence(10, "month"), 24000);
  });

  it("charges repo #11 at the second band, not the whole account", () => {
    assert.equal(bandedTotalPence(11, "month"), 24000 + 1800);
    assert.equal(bandedTotalPence(50, "month"), 10 * 2400 + 40 * 1800);
  });

  it("matches the documented example: 100 repos → £1,560/mo", () => {
    assert.equal(bandedTotalPence(100, "month"), 156000);
    assert.equal(formatGbpAmount(bandedTotalPence(100, "month")), "£1,560");
  });

  it("applies the £8 floor band above 150 repos", () => {
    assert.equal(bandedTotalPence(150, "month"), 24000 + 72000 + 120000);
    assert.equal(bandedTotalPence(200, "month"), 216000 + 50 * 800);
  });

  it("annual bands are ≈ ×10 of monthly (≈ 2 months free)", () => {
    assert.equal(bandedTotalPence(100, "year"), 1_560_000);
    assert.equal(bandedTotalPence(100, "year"), bandedTotalPence(100, "month") * 10);
  });
});

describe("entryRatePence + annualSavingPercent", () => {
  it('entry rate is the first-band per-repo price (the "from £24")', () => {
    assert.equal(entryRatePence(), 2400);
    assert.equal(entryRatePence("year"), 24000);
    assert.equal(formatGbp(entryRatePence()), "£24");
  });

  it("annual saving is a constant 17% (proportional ×10 bands)", () => {
    assert.equal(annualSavingPercent(), 17);
  });
});

describe("GBP formatting", () => {
  it("formatGbp — compact, no separators", () => {
    assert.equal(formatGbp(0), "£0");
    assert.equal(formatGbp(2400), "£24");
    assert.equal(formatGbp(800), "£8");
    assert.equal(formatGbp(850), "£8.50");
  });

  it("formatGbpAmount — thousands separators, 2dp only when needed", () => {
    assert.equal(formatGbpAmount(156000), "£1,560");
    assert.equal(formatGbpAmount(750000), "£7,500");
    assert.equal(formatGbpAmount(155050), "£1,550.50");
  });
});
