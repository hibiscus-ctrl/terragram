// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { after, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { getCurrentMembership } from "@/features/account/controllers/get-or-create-org";
import { rateLimited } from "@/features/api/rate-limit-route";
import { parseBody } from "@/features/api/responses";
import { withRouteErrors } from "@/features/api/route-errors";
import { managedEntitled } from "@/features/billing/managed-entitlement";
import { recordManagedMint } from "@/features/billing/managed-usage";
import { getSettings } from "@/features/workspace/store";
import { translateChat, translateRequestSchema } from "@/features/workspace/translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspace/translate — Chat → Model for the workspace. Session-authed
 * (browser-called, not the Action bearer path). Dispatches to managed UK inference
 * or the deterministic engine; the org id is resolved server-side for metering.
 */
async function handlePost(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Each managed call is a real Bedrock invocation — throttle per user before
  // reading the body. The client falls back to its deterministic engine on 429.
  const limited = await rateLimited(`translate:${user.id}`, { limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const body = await parseBody(request, translateRequestSchema);
  if (!body.ok) return body.response;

  // Managed inference is metered per org and only for an entitled one (same gate as
  // the mint route + the usage callback — `recordManagedUsage` won't bill anyone
  // else). A brand-new account (org still provisioning) or a free org translates
  // deterministically instead of accruing unbillable Bedrock spend.
  // The chosen model is read from the user's stored settings HERE rather than taken
  // from the request body. It reaches the proxy, and the proxy forwards any id with
  // a dot in it as a raw Bedrock id — so the safest wire is one that never carries
  // the field at all. `resolvedModel` still validates what this returns.
  const [membership, settings] = await Promise.all([getCurrentMembership(), getSettings(user.id)]);
  const managedOrgId = membership && managedEntitled(membership.org) ? membership.org.id : null;

  const result = await translateChat({
    managedOrgId,
    prompt: body.data.prompt,
    inferenceModel: settings.inferenceModel,
    // Handed to `after()` rather than left as a floating promise: Next only awaits
    // work registered through `after`/`waitUntil` once the response is sent, so a
    // mint during a deploy or scale-down could otherwise answer and never leave its
    // ledger row, which is exactly the "gateway spent but never reported" signal the
    // reconcile job looks for, lost silently. The insert still STARTS here (a
    // promise, not a callback); `after` only makes the runtime wait for it. The
    // binding lives in the route because the inference core stays free of
    // `next/server` to remain unit-testable.
    recordMint: (orgId, budgetPence) => after(recordManagedMint(orgId, budgetPence)),
    ...(body.data.model ? { prev: body.data.model } : {}),
  });

  return NextResponse.json(result);
}

export const POST = withRouteErrors(handlePost);
