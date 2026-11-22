// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type Stripe from "stripe";

import { stripeAdmin } from "@/libs/stripe/stripe-admin";

/**
 * Verify a Stripe webhook's signature over the raw body and parse the event.
 *
 * Here rather than in the route so the Stripe client (and its secret key) has no
 * importer outside `features/billing/`. `constructEventAsync` works in every
 * runtime; prefer it over `constructEvent`.
 */
export function constructStripeEvent(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): Promise<Stripe.Event> {
  return stripeAdmin.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
}
