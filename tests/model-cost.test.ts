/**
 * Unit tests for the money meter (Phase D): marked-up Bedrock cost in pence, the
 * per-repo allowance, and the allowance-crossover metering. Pure — run with
 * `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeManagedCostPence,
  meterableOverPence,
  rateForModel,
  teamAllowancePence,
} from "../src/features/billing/model-cost.ts";

const RATES = {
  currency: "GBP",
  unit: "1M tokens",
  note: "test fixture",
  cacheNote: "test fixture",
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  default: { inputPer1m: 100, outputPer1m: 200 },
  models: [
    { match: "claude", inputPer1m: 300, outputPer1m: 1500 },
    { match: "claude-opus", inputPer1m: 1000, outputPer1m: 2000 },
  ],
};

describe("rateForModel", () => {
  it("picks the longest matching substring (claude-opus over claude)", () => {
    assert.deepEqual(rateForModel("eu.anthropic.claude-opus-4-7", RATES), {
      inputPer1m: 1000,
      outputPer1m: 2000,
    });
    assert.deepEqual(rateForModel("eu.anthropic.claude-sonnet", RATES), {
      inputPer1m: 300,
      outputPer1m: 1500,
    });
  });

  it("falls back to the default for an unknown model or null", () => {
    assert.deepEqual(rateForModel("amazon.titan", RATES), { inputPer1m: 100, outputPer1m: 200 });
    assert.deepEqual(rateForModel(null, RATES), { inputPer1m: 100, outputPer1m: 200 });
  });
});

describe("computeManagedCostPence", () => {
  it("is tokens x rate (per 1M), integer pence, no markup", () => {
    const cost = computeManagedCostPence(
      { model: "eu.anthropic.claude-opus-4-7", inputTokens: 500_000, outputTokens: 250_000 },
      RATES,
      1,
    );
    assert.equal(cost, 500 + 500); // 0.5M*1000 + 0.25M*2000 = 1000
  });

  it("applies the markup and rounds to the nearest penny", () => {
    const cost = computeManagedCostPence(
      { model: "eu.anthropic.claude-opus-4-7", inputTokens: 500_000, outputTokens: 250_000 },
      RATES,
      1.15,
    );
    assert.equal(cost, Math.round(1000 * 1.15)); // 1150
  });

  it("uses the default rate for an unknown model", () => {
    assert.equal(
      computeManagedCostPence(
        { model: "mystery", inputTokens: 1_000_000, outputTokens: 1_000_000 },
        RATES,
        1,
      ),
      300,
    );
  });

  it("never goes negative on junk token counts", () => {
    assert.equal(
      computeManagedCostPence({ model: null, inputTokens: -5, outputTokens: -9 }, RATES, 1.15),
      0,
    );
  });

  it("bills cache reads at a tenth and cache writes at 1.25x of the input rate", () => {
    const model = "eu.anthropic.claude-opus-4-7"; // input 1000/1M
    assert.equal(
      computeManagedCostPence(
        { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
        RATES,
        1,
      ),
      100,
    );
    assert.equal(
      computeManagedCostPence(
        { model, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
        RATES,
        1,
      ),
      1250,
    );
  });

  it("adds the cache terms to input and output — the counts are disjoint", () => {
    const cost = computeManagedCostPence(
      {
        model: "eu.anthropic.claude-opus-4-7",
        inputTokens: 500_000,
        outputTokens: 250_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      RATES,
      1,
    );
    assert.equal(cost, 1000 + 100 + 1250);
  });

  it("never goes negative on junk cache counts", () => {
    assert.equal(
      computeManagedCostPence(
        { model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: -5, cacheWriteTokens: -9 },
        RATES,
        1,
      ),
      0,
    );
  });
});

describe("teamAllowancePence", () => {
  it("scales with billable repos and clamps at 0", () => {
    assert.equal(teamAllowancePence(10, 500), 5000);
    assert.equal(teamAllowancePence(0, 500), 0);
    assert.equal(teamAllowancePence(-3, 500), 0);
    assert.equal(teamAllowancePence(10, -5), 0);
  });
});

describe("meterableOverPence (allowance crossover)", () => {
  it("meters nothing while under the allowance", () => {
    assert.equal(meterableOverPence(0, 100, 1000), 0);
    assert.equal(meterableOverPence(500, 400, 1000), 0);
  });

  it("meters only the portion above the allowance when a charge straddles it", () => {
    assert.equal(meterableOverPence(900, 200, 1000), 100);
    assert.equal(meterableOverPence(1000, 100, 1000), 100);
  });

  it("meters the full charge once the allowance is already spent", () => {
    assert.equal(meterableOverPence(2000, 300, 1000), 300);
  });

  it("is never negative", () => {
    assert.equal(meterableOverPence(0, 0, 0), 0);
    assert.equal(meterableOverPence(0, 50, 0), 50);
  });

  it("telescopes across a sequence to exactly max(0, total - allowance)", () => {
    // recordManagedUsage meters each call against the running managed_cost ledger
    // (prior). Summed over a cycle, the metered overage must equal what a single
    // charge of the total would meter — otherwise the allowance mis-bills.
    const sequences: { costs: number[]; allowance: number }[] = [
      { costs: [300, 400, 500], allowance: 1000 },
      { costs: [100, 100, 100], allowance: 1000 },
      { costs: [2000], allowance: 1000 },
      { costs: [600, 600], allowance: 1000 },
      { costs: [0, 0, 1500, 0], allowance: 1000 },
      { costs: [1000, 1, 1], allowance: 1000 },
      { costs: [500, 500, 500], allowance: 0 },
    ];
    for (const { costs, allowance } of sequences) {
      let prior = 0;
      let metered = 0;
      for (const cost of costs) {
        const over = meterableOverPence(prior, cost, allowance);
        assert.ok(over >= 0, `overage must never be negative (${costs}/${allowance})`);
        metered += over;
        prior += cost;
      }
      const total = costs.reduce((a, b) => a + b, 0);
      assert.equal(
        metered,
        Math.max(0, total - allowance),
        `telescoping failed for ${costs}/${allowance}`,
      );
    }
  });
});
