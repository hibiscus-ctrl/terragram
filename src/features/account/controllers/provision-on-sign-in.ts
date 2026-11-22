import type { User } from "@supabase/supabase-js";

import { acceptPendingInvites } from "@/features/app/invites";
import { reconcileScimMemberships } from "@/features/scim/scim-provisioning";
import { logger } from "@/libs/log";

import { getOrCreateOrg } from "./get-or-create-org";

const log = logger("account/provisioning");

/**
 * The org-provisioning seam shared by every sign-in entry point (the OAuth /
 * email-confirmation callback AND the password sign-in action). Provisioning must
 * NOT happen during render — it lives here, in the write-safe post-authentication
 * step, so a signed-in user always has a membership before the app layout/guards run.
 *
 *   1. Accept any pending invites matching this user's email FIRST, so an invited
 *      user joins the inviter's org instead of getting their own personal org.
 *   2. Reconcile IdP-provisioned (SCIM) memberships for this email.
 *   3. getOrCreateOrg then finds that joined org, or provisions a fresh personal
 *      org + admin membership for a user with no invite/membership.
 *
 * Best-effort: a failure here shouldn't block landing in the app. But because it can
 * fail (and leave an authenticated user org-less), the deny target /login also calls
 * getOrCreateOrg so the org-less state can never trap the user in a redirect loop.
 */
export async function provisionSignedInUser(user: User): Promise<void> {
  try {
    await acceptPendingInvites(user);
    await reconcileScimMemberships(user);
    await getOrCreateOrg();
  } catch (error) {
    log.error("org provisioning on sign-in failed", { err: error });
  }
}
