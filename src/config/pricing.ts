// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import pricing from "./pricing.json" with { type: "json" };

/**
 * Single source of truth for the published prices. The same numbers drive the
 * marketing pricing page AND the Stripe catalogue (`scripts/stripe-setup.mjs`
 * reads this JSON), so the two can never drift. Amounts are in the currency's
 * minor unit (pence). Edit `pricing.json` to change a price, then re-run
 * `npm run stripe:setup` to update Stripe.
 *
 * Team is per-seat with marginal (graduated) volume banding: seat #15 is charged
 * at the 11–50 band rate, not the whole account. `bandedTotalPence` is the one
 * place that math lives — the calculator, the billing page and the checkout
 * quantity all read it (or the Stripe-side graduated tiers built from the same
 * `bands`), so the customer-facing total and the invoice can never diverge.
 */
export const PRICING = pricing;

/**
 * The stable Stripe `lookup_key`s the catalogue script assigns to each price.
 * Because they never change (the script transfers a key onto a new price when a
 * number changes), the app resolves the live price id from these at runtime — so
 * no `STRIPE_*_PRICE_ID` env var has to be copied in by hand. Same JSON the script
 * reads, so the two can't drift.
 */
export const STRIPE_LOOKUP_KEYS = PRICING.stripe.lookupKeys;

/** The Stripe Billing Meter event the managed-model money meter reports to. */
export const MANAGED_COST_METER_EVENT = PRICING.managedCost.meterEventName;

export type PlanTier = "payg" | "team";

export type Interval = "month" | "year";

/** One marginal pricing band: every repo up to `upTo` (cumulative; `null` = no
 *  ceiling) is charged `pence` per interval. */
type Band = { upTo: number | null; pence: number };

/** Format a minor-unit amount as GBP — `£0`, `£24`, `£8`, `£8.50`. */
export function formatGbp(pence: number): string {
  if (pence === 0) return "£0";
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/** GBP with thousands separators — for the larger banded totals (`£1,560`). */
export function formatGbpAmount(pence: number): string {
  const pounds = pence / 100;
  const fractionDigits = Number.isInteger(pounds) ? 0 : 2;
  return `£${pounds.toLocaleString("en-GB", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

function teamBands(interval: Interval): Band[] {
  return PRICING.tiers.team.bands[interval];
}

/**
 * The marginal (graduated) Team total for `seats` at the given
 * interval, in pence. Mirrors Stripe `tiers_mode: 'graduated'` exactly: each band
 * charges only the seats that fall inside it. 100 seats/month → £1,560.
 */
export function bandedTotalPence(seats: number, interval: Interval): number {
  if (seats <= 0) return 0;
  let total = 0;
  let lower = 0;
  for (const band of teamBands(interval)) {
    if (seats <= lower) break;
    const upper = band.upTo ?? Number.POSITIVE_INFINITY;
    const countInBand = Math.min(seats, upper) - lower;
    total += countInBand * band.pence;
    lower = upper;
  }
  return total;
}

/** The entry (first-band) per-seat rate — the "from £24" headline. */
export function entryRatePence(interval: Interval = "month"): number {
  return teamBands(interval)[0]?.pence ?? 0;
}

/** The included managed-model allowance per seat per UTC month, in pence.
 *  `0` would mean every penny of managed spend is billable from the first token. */
export function managedAllowancePerSeatPence(): number {
  return PRICING.managedCost.allowancePerSeatPence ?? 0;
}

/**
 * Annual saving vs paying monthly for a year, as a whole-percent. The bands scale
 * proportionally (annual ≈ ×10 of monthly), so the percentage is constant across
 * seat counts — compute it from a single seat.
 */
export function annualSavingPercent(): number {
  const monthly = bandedTotalPence(1, "month");
  const annual = bandedTotalPence(1, "year");
  if (!monthly || !annual) return 0;
  const fullYear = monthly * 12;
  return Math.round(((fullYear - annual) / fullYear) * 100);
}
