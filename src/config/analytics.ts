// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_ID?.trim() ?? "";

export const CONSENT_COOKIE = "tg-analytics-consent";

export const CONSENT_MAX_AGE = 60 * 60 * 24 * 180;

export type ConsentState = "granted" | "denied";

export function isConsentState(value: string | undefined): value is ConsentState {
  return value === "granted" || value === "denied";
}
