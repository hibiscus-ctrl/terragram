// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

import { getCurrentMembership } from "./get-or-create-org";
import { pageVerdict } from "./page-guards-core";
import type { Capability } from "./permissions";

/**
 * Per-page RBAC guard — the WIRING. Each account-dashboard page calls it with the
 * capability it needs; a member without it is redirected to a page they CAN open.
 * The rules live in (and are tested through) `page-guards-core.ts`; this only
 * resolves the session and turns a verdict into a `redirect()`.
 */
export async function guardPage(capability: Capability): Promise<void> {
  const to = pageVerdict(await getCurrentMembership(), capability);
  if (to) redirect(to);
}
