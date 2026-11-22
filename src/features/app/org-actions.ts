"use server";

import { revalidatePath } from "next/cache";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import {
  actionRateLimit,
  guardMemberAction,
} from "@/features/account/controllers/action-guards";
import { slugify } from "@/features/account/controllers/get-or-create-org";
import {
  type CreateOrgResult,
  type DeleteOrganisationResult,
  makeOrgActions,
  type OrgActionResult,
} from "@/features/app/org-core";
import { teardownOrg } from "@/features/app/org-teardown";
import { syncOrgSeats } from "@/features/billing/seat-sync";
import { deleteMembership, getMembershipRole } from "@/features/data/members";
import { deleteOrgRow, insertBootstrapMembership, insertOrg } from "@/features/data/orgs";
import { recordAudit } from "@/features/platform/super-owner";

export type { DeleteOrganisationResult, OrgActionResult };

// The decisions live in `org-core.ts`; this is the production binding. A
// `"use server"` module may only export async functions, hence the wrappers.
const actions = makeOrgActions({
  guard: guardMemberAction,
  rateLimit: actionRateLimit,
  getAuthenticatedUser,
  slugify,
  insertOrg,
  insertBootstrapMembership,
  deleteOrgRow,
  teardownOrg,
  getMembershipRole,
  syncSeats: syncOrgSeats,
  deleteMembership,
  recordAudit,
  revalidate: revalidatePath,
});

/** @public No caller yet: no screen creates a second org. */
export async function createOrganisation(name: string): Promise<CreateOrgResult> {
  return actions.createOrganisation(name);
}

export async function deleteOrganisation(confirmation: string): Promise<DeleteOrganisationResult> {
  return actions.deleteOrganisation(confirmation);
}

export async function transferOwnership(input: {
  userId: string;
  confirmation: string;
}): Promise<OrgActionResult> {
  return actions.transferOwnership(input);
}
