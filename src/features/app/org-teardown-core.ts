import type { AuditActorType, AuditEntry } from "@/features/platform/audit-events";

/**
 * What happens once an org has been confirmed for deletion. The caller has already
 * authorised the deletion and written its own "deleted" audit row.
 *
 * Order is load-bearing:
 *  1. Delete the `orgs` row. Every `org_id` FK cascades, so the tenant's data goes
 *     in one statement. If this fails, NOTHING else happens — the org still
 *     exists, so its subscription must keep running.
 *  2. Cancel the Stripe subscription, so a deleted org stops billing.
 *
 * Step 2 can fail after the org is gone. It may not undo the deletion, and it may
 * not pass silently: the failure is audited (org id null — the row it would point
 * at no longer exists) and reported back so the caller can tell the member.
 */

export type TeardownOrg = {
  id: string;
  github_login: string | null;
  stripe_subscription_id: string | null;
};

export type OrgTeardownDeps = {
  /** `false` = the delete failed and the org still exists. */
  deleteOrgRow: (orgId: string) => Promise<boolean>;
  /** `false` = Stripe did not confirm the cancellation. */
  cancelSubscription: (subscriptionId: string) => Promise<boolean>;
  recordAudit: (entry: AuditEntry) => Promise<unknown>;
};

export type OrgTeardownResult =
  | { ok: false }
  | {
      ok: true;
      /** The subscription Stripe did not confirm cancelling, if any. */
      subscriptionNotCancelled: string | null;
    };

export function makeOrgTeardown(deps: OrgTeardownDeps) {
  return async function teardownOrg(
    org: TeardownOrg,
    actor: { id: string | null; email: string | null; type: AuditActorType },
  ): Promise<OrgTeardownResult> {
    if (!(await deps.deleteOrgRow(org.id))) return { ok: false };

    const subscription = org.stripe_subscription_id;
    if (subscription && !(await deps.cancelSubscription(subscription))) {
      await deps.recordAudit({
        orgId: null,
        actorId: actor.id,
        actorEmail: actor.email,
        actorType: actor.type,
        action: "org.subscription_cancel_failed",
        targetType: "org",
        targetId: org.id,
        targetLabel: org.github_login ?? org.id,
        metadata: { subscription },
      });
      return { ok: true, subscriptionNotCancelled: subscription };
    }
    return { ok: true, subscriptionNotCancelled: null };
  };
}
