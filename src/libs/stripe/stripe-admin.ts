// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// Structural enforcement of the rule below. `server-only` resolves to an empty
// module under the react-server condition and to a module that THROWS anywhere
// else, so importing this file from a Client Component fails the BUILD instead
// of failing at runtime — or, worse, silently shipping a client bundle carrying
// a service-role key. The comment alone was the only guard before.
import "server-only";

import Stripe from "stripe";

import { lazyClient } from "@/libs/lazy-client";
import { getEnvVar } from "@/utils/get-env-var";

// Lazily constructed so the secret is read at request time, not at import — keeps
// `next build` from needing STRIPE_SECRET_KEY. See {@link lazyClient}.
export const stripeAdmin = lazyClient(
  () =>
    new Stripe(getEnvVar(process.env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY"), {
      // Omitting `apiVersion` pins requests to the API version this SDK was built
      // against (stripe-node v19 → `2025-09-30.clover`). To pin explicitly, set e.g.
      // apiVersion: '2025-09-30.clover'
      // https://github.com/stripe/stripe-node#configuration
      //
      // Register this as an official Stripe plugin.
      // https://stripe.com/docs/building-plugins#setappinfo
      appInfo: {
        name: "Terragram Cloud",
        version: "0.1.0",
      },
    }),
);
