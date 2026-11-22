import { makeOrgTeardown } from "@/features/app/org-teardown-core";
import { cancelSubscriptionBestEffort } from "@/features/billing/stripe-billing";
import { deleteOrgRow } from "@/features/data/orgs";
import { recordAudit } from "@/features/platform/super-owner";

/** The production binding of the org teardown; see `org-teardown-core.ts`. */
export const teardownOrg = makeOrgTeardown({
  deleteOrgRow,
  cancelSubscription: cancelSubscriptionBestEffort,
  recordAudit,
});
