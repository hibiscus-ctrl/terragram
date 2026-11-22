import { NextResponse } from "next/server";

import { checkEnv } from "@/config/env";
import { readiness } from "@/features/api/readiness";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe — the dependency-checking sibling of the liveness-only
 * `/api/health`. Deploy gating points HERE, so a deployment with a broken
 * `SUPABASE_SECRET_KEY` (or an unapplied migration) fails its healthcheck instead
 * of reporting a healthy process in front of a 500-ing app.
 *
 * The probe reads Terragram's own `terragram_workspaces` rather than a table the
 * shared project's other app owns, so it also proves this app's migration is
 * applied. A presence probe (`limit 1`), not a count: this endpoint is hit
 * continuously, and a count would scan the table on every hit as it grows.
 */
export async function GET() {
  let databaseOk = false;
  try {
    const { error } = await supabaseAdminClient.from("terragram_workspaces").select("id").limit(1);
    databaseOk = !error;
  } catch {
    // A missing secret throws at client construction — that is "not ready" too.
    databaseOk = false;
  }

  const { status, body } = readiness({ databaseOk, env: checkEnv(), now: new Date() });
  return NextResponse.json(body, { status });
}
