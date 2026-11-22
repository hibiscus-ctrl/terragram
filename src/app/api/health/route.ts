// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";

// Liveness probe. Intentionally dependency-free: it must succeed even if Supabase/Stripe
// are momentarily unreachable, so it reports the *process* as healthy rather than
// flapping on a downstream outage. Deploy gating uses `/api/health/ready` instead.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "terragram-ui",
    time: new Date().toISOString(),
  });
}
