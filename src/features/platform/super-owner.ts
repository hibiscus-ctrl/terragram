// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { logger } from "@/libs/log";
import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

import type { AuditEntry } from "./audit-events";

const log = logger("platform/audit");

/**
 * The immutable audit-log writer. The cross-tenant operator console was removed in
 * the Terragram consolidation; the audit trail it wrote to remains, recording the
 * privileged account actions (org delete/transfer, managed opt-out).
 *
 * Append a row to the immutable audit_log (service-role). `action` must be one of
 * the catalogued events (`AUDIT_EVENTS`) and `actorType` one of the live
 * constraint's values — see `audit-events.ts` for the conventions every entry
 * follows. Returns whether the write landed: most callers treat audit as
 * best-effort and ignore it, but a privileged action must treat a failed audit
 * write as a hard error — a powerful action that left no trace is worse than one
 * that didn't run.
 */
export async function recordAudit(entry: AuditEntry): Promise<boolean> {
  const { error } = await supabaseAdminClient.from("audit_log").insert({
    org_id: entry.orgId ?? null,
    actor_id: entry.actorId ?? null,
    actor_email: entry.actorEmail ?? null,
    actor_type: entry.actorType,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    target_label: entry.targetLabel ?? null,
    metadata: entry.metadata ?? {},
  });
  if (error) {
    log.warn("failed to record audit entry", { action: entry.action, err: error });
    return false;
  }
  return true;
}
