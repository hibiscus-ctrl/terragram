// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prepaid credit — pure helpers shared by the top-up action, the webhook and the
 * billing view. Credit lives on the Stripe customer balance: a NEGATIVE balance is
 * credit Stripe will draw down against future invoices before charging the card.
 * Keep this file free of server imports so it stays unit-testable.
 */

/** Offered top-up amounts (pence). */
export const TOPUP_PRESETS_PENCE = [1000, 2500, 5000, 10000] as const;

/** Bounds for a single top-up (pence): £5 floor, £10,000 ceiling. Larger prepayments
 *  are handled out-of-band (the dialog points to Contact us). */
export const MIN_TOPUP_PENCE = 500;
export const MAX_TOPUP_PENCE = 1_000_000;

/** Validate a requested top-up to a whole-penny amount within bounds; `null` if
 *  it isn't a finite number in range. */
export function normalizeTopupPence(input: unknown): number | null {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return null;
  const pence = Math.round(n);
  if (pence < MIN_TOPUP_PENCE || pence > MAX_TOPUP_PENCE) return null;
  return pence;
}

/** Available prepaid credit (pence) from a Stripe customer balance. Stripe stores
 *  credit as a negative balance; a positive balance is an amount owed, not credit. */
export function availableCreditPence(stripeBalance: number | null | undefined): number {
  const balance = typeof stripeBalance === "number" ? stripeBalance : 0;
  return balance < 0 ? -balance : 0;
}
