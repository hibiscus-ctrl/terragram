"use server";

import { revalidatePath } from "next/cache";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { guardMemberAction } from "@/features/account/controllers/action-guards";
import { allows } from "@/features/account/controllers/permissions";
import { setOrgManagedOptOut } from "@/features/data/orgs";
import { recordAudit } from "@/features/platform/super-owner";

/**
 * Turn managed models on/off for the org WITHOUT touching the subscription. Managed
 * models are otherwise derived from having an active sub (`plan='payg'`); this flag
 * lets a paying org (incl. Team) keep its plan but stop routing keyless runs through
 * our EU Bedrock proxy — `/api/proxy-token` then declines and runs fall back to the
 * free model. `billing.manage` only.
 */
export async function setManagedModelsOptOut(
  optOut: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const guard = await guardMemberAction({
    require: allows("billing.manage"),
    permissionError: "You do not have access to manage billing.",
    signedOutError: "Could not resolve your organisation. Please try again.",
    provision: true,
  });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { membership } = guard;

  const updated = await setOrgManagedOptOut(membership.org.id, optOut);
  if (!updated) return { ok: false, error: "Could not update managed models. Please try again." };

  const actor = await getAuthenticatedUser();
  const audited = await recordAudit({
    orgId: membership.org.id,
    actorId: membership.userId,
    actorEmail: actor?.email ?? null,
    actorType: "member",
    action: optOut ? "managed_models.disable" : "managed_models.enable",
    targetType: "org",
    targetId: membership.org.id,
    targetLabel: membership.org.name ?? null,
  });
  if (!audited) {
    // A privileged change that left no trace must not stand: put the switch back.
    await setOrgManagedOptOut(membership.org.id, membership.org.managed_opt_out);
    return { ok: false, error: "The change could not be recorded, so it was not applied. Please try again." };
  }

  revalidatePath("/billing");
  return { ok: true };
}
