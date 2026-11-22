// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// Structural enforcement of the rule below. `server-only` resolves to an empty
// module under the react-server condition and to a module that THROWS anywhere
// else, so importing this file from a Client Component fails the BUILD instead
// of failing at runtime — or, worse, silently shipping a client bundle carrying
// a service-role key. The comment alone was the only guard before.
import "server-only";

import { lazyClient } from "@/libs/lazy-client";
import type { Database } from "@/libs/supabase/types";
import { getEnvVar } from "@/utils/get-env-var";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — **bypasses Row Level Security entirely.**
 *
 * Terragram's tenancy model is *app-side*, not RLS-side: the API authenticates a
 * request (org token / OIDC / signed-in user), resolves the caller's `org_id`,
 * and every query made through this client MUST be constrained by that id
 * (`.eq('org_id', ctx.org.id)` or a `repo_id` already proven to belong to it).
 * The database will NOT do that filtering for you here — RLS is not consulted.
 *
 * Why service-role instead of per-user RLS: the engine talks to this API with an
 * org token (no Supabase auth session), webhooks arrive unauthenticated-at-the-
 * edge, and operator/billing flows cross org boundaries deliberately. A single
 * trusted server-side client with explicit, auditable tenancy checks is simpler
 * to reason about than threading RLS policies through all of those.
 *
 * RULES when using this client:
 *   1. Reads/writes scoped to a tenant MUST filter on the authenticated `org_id`.
 *   2. NEVER import this into a Client Component or expose it to the browser — it
 *      holds the secret key and can read/write every org's data.
 *   3. Cross-org/global queries (operator console, billing reconciliation) are
 *      the only exception and must be reachable only behind a super-owner check.
 */
// Lazily constructed: the service key is read on first use (request time), not at
// import — so `next build` can collect page data without the runtime secret. See
// {@link lazyClient}.
export const supabaseAdminClient = lazyClient(() =>
  createClient<Database>(
    getEnvVar(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    getEnvVar(
      process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
      "SUPABASE_SECRET_KEY",
    ),
  ),
);
