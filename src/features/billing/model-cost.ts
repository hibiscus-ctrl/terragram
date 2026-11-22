// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import modelRates from "@/config/model-rates.json" with { type: "json" };
import pricing from "@/config/pricing.json" with { type: "json" };

/**
 * The money meter (D5): bill the actual marked-up AWS Bedrock cost, not a flat
 * per-run number. The proxy reports real token usage; we compute
 * `tokens x rate x markup` in integer pence and meter that. Per-model rate
 * differences live in `model-rates.json` and never touch Stripe — the Stripe
 * metered price is a flat 1 unit = 1 penny, so adding a model is a rate-card edit.
 *
 * The Team allowance is expressed as £ of included managed spend/month, scaled by
 * seats; only spend ABOVE the allowance is metered (`meterableOverPence`).
 * All of this is pure so the cost math + allowance crossover are unit-tested.
 */

export type ModelRate = { inputPer1m: number; outputPer1m: number };
export type TokenUsage = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads and writes. Bedrock reports these DISJOINT from
   *  `inputTokens`, so each is billed as its own term rather than folded into it. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const MANAGED_COST = pricing.managedCost;

/** The rate for a model id — longest `match` substring wins, else the default. */
export function rateForModel(model: string | null, rates = modelRates): ModelRate {
  const id = (model ?? "").toLowerCase();
  let best: ModelRate | null = null;
  let bestLen = -1;
  for (const entry of rates.models) {
    if (id.includes(entry.match) && entry.match.length > bestLen) {
      best = { inputPer1m: entry.inputPer1m, outputPer1m: entry.outputPer1m };
      bestLen = entry.match.length;
    }
  }
  return best ?? rates.default;
}

/**
 * Marked-up managed-model cost for one usage report, in integer pence. Rounds to
 * the nearest penny and never returns a negative value. `markup` defaults to the
 * configured 1.15 (cost + ~15%).
 *
 * Four token classes, not two. Bedrock reports uncached input, cache reads and
 * cache writes as disjoint counts, so each is billed once at its own rate (a
 * multiple of the model's input rate). Billing a cache read as ordinary input
 * would overcharge it roughly tenfold; ignoring it would bill a cached prompt
 * as nearly free.
 */
export function computeManagedCostPence(
  usage: TokenUsage,
  rates = modelRates,
  markup: number = MANAGED_COST.markup,
): number {
  const rate = rateForModel(usage.model, rates);
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const readRate = rate.inputPer1m * rates.cacheReadMultiplier;
  const writeRate = rate.inputPer1m * rates.cacheWriteMultiplier;
  const raw =
    ((input * rate.inputPer1m) / 1_000_000 +
      (output * rate.outputPer1m) / 1_000_000 +
      (cacheRead * readRate) / 1_000_000 +
      (cacheWrite * writeRate) / 1_000_000) *
    markup;
  return Math.max(0, Math.round(raw));
}

/** The org's £ included managed allowance/month, in pence — scaled by seats. */
export function teamAllowancePence(
  seats: number,
  perSeatPence: number = MANAGED_COST.allowancePerSeatPence,
): number {
  return Math.max(0, seats) * Math.max(0, perSeatPence);
}

/**
 * The portion of a new charge that falls ABOVE the allowance, given how much has
 * already been spent this cycle. Handles a charge that straddles the allowance
 * boundary: spend below the allowance is free, spend above is 1:1. Never negative.
 */
export function meterableOverPence(
  priorCostPence: number,
  newCostPence: number,
  allowancePence: number,
): number {
  const prior = Math.max(0, priorCostPence);
  const next = Math.max(0, newCostPence);
  const allowance = Math.max(0, allowancePence);
  const billedBefore = Math.max(0, prior - allowance);
  const billedAfter = Math.max(0, prior + next - allowance);
  return billedAfter - billedBefore;
}
