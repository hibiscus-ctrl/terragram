// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { after, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { getCurrentMembership } from "@/features/account/controllers/get-or-create-org";
import { rateLimited } from "@/features/api/rate-limit-route";
import { apiError } from "@/features/api/responses";
import { withRouteErrors } from "@/features/api/route-errors";
import { managedEntitled } from "@/features/billing/managed-entitlement";
import { recordManagedMint } from "@/features/billing/managed-usage";
import { ManagedCapReachedError } from "@/features/workspace/inference";
import { logger } from "@/libs/log";
import { managedEngineEnabled } from "@/features/workspace/translate";
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, runManagedDiagramRead } from "@/features/workspace/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("api/read-diagram");

/** Base64 is 4/3 of the bytes; the JSON wrapper is a few hundred more. */
const MAX_BODY_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4_096;

const bodySchema = z.object({
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  data: z.string().min(1),
});

/**
 * POST /api/workspace/read-diagram — a picture of a diagram → model. Session-authed.
 * Unlike translate, there is no deterministic path to fall back to: a picture
 * cannot be read without a vision model, so an org that cannot use managed
 * inference gets a clear 409 rather than a silent sample.
 */
async function handlePost(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // A vision call is the most expensive thing the workspace does; throttle harder
  // than chat, and before the image is even read.
  const limited = await rateLimited(`read-diagram:${user.id}`, { limit: 5, windowMs: 60_000 });
  if (limited) return limited;

  if (!managedEngineEnabled()) {
    return apiError(409, "Reading a picture needs managed inference, which is not enabled on this deployment. Paste a Mermaid flowchart instead.");
  }
  const membership = await getCurrentMembership();
  if (!membership || !managedEntitled(membership.org)) {
    return apiError(409, "Reading a picture uses managed inference, which your organisation is not set up for. Paste a Mermaid flowchart instead, or enable managed models on the billing page.");
  }

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return apiError(413, "That image is too large. Keep it under 4.5 MB.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return apiError(413, "That image is too large. Keep it under 4.5 MB.");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return apiError(400, "Invalid JSON body");
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return apiError(400, "Send the image as base64 with one of the supported media types.");

  try {
    const result = await runManagedDiagramRead({
      orgId: membership.org.id,
      image: body.data,
      // Registered with `after()` so the runtime awaits the ledger write (see the
      // translate route).
      recordMint: (orgId, budgetPence) => after(recordManagedMint(orgId, budgetPence)),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ManagedCapReachedError) {
      return apiError(402, "Your organisation's managed-model spend cap for this cycle has been reached.");
    }
    log.error("read failed", { err });
    return apiError(502, "The picture could not be read. Try a clearer image, or paste a Mermaid flowchart.");
  }
}

export const POST = withRouteErrors(handlePost);
