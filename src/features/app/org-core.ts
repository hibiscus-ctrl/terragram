// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";

import type {
  ActionGuardFailure,
  ActionGuardResult,
  ActionRateLimitOptions,
  GuardMemberActionOptions,
} from "@/features/account/controllers/action-guards";
import type { OrgRole } from "@/features/account/controllers/permissions";
import type { MembershipMutationResult } from "@/features/data/members";
import type { AuditActorType, AuditEntry } from "@/features/platform/audit-events";

import type { OrgTeardownResult, TeardownOrg } from "./org-teardown-core.ts";

import { allows } from "@/features/account/controllers/permissions";

/**
 * The organisation-lifecycle actions' decisions — who may create, delete or hand
 * over an org, what each one must re-type to confirm, which scarce rate limit is
 * spent and WHEN, who a transfer may hand the org to, and that a privileged action
 * whose audit record can't be written does not run. Behind injected collaborators
 * so a test can drive every refusal and the exact call ORDER with no Supabase, no
 * Stripe and no session; `org-actions.ts` binds the production adapters.
 */

const PERMISSION_ERROR = "You need the Admin role to manage this organisation.";
const SIGNED_OUT_ERROR = "Sign in to manage your organisation.";
const CREATE_SIGNED_OUT_ERROR = "Sign in to create an organisation.";
const HOUR_MS = 60 * 60_000;

export type OrgActionResult = { ok: boolean; error?: string };

/** A deletion that went through but left billing unconfirmed carries a `warning`. */
export type DeleteOrganisationResult = { ok: true; warning?: string } | { ok: false; error: string };

export type CreateOrgResult = { ok: true; slug: string } | { ok: false; error: string };

export type OrgActionDeps = {
  guard: (opts: GuardMemberActionOptions) => Promise<ActionGuardResult>;
  /** Consume one unit of a named per-user limit. */
  rateLimit: (
    name: string,
    userId: string,
    opts: ActionRateLimitOptions,
  ) => Promise<{ ok: true } | ActionGuardFailure>;
  getAuthenticatedUser: () => Promise<{ id: string; email?: string | null | undefined } | null>;
  slugify: (value: string) => string;
  /** Disambiguating suffix for a colliding slug. Defaults to two random bytes. */
  randomSuffix?: () => string;
  insertOrg: (githubLogin: string, name: string) => Promise<{ id: string; github_login: string } | null>;
  insertBootstrapMembership: (orgId: string, userId: string) => Promise<boolean>;
  /** Rolls back an org whose bootstrap membership failed. */
  deleteOrgRow: (orgId: string) => Promise<boolean>;
  /** Delete the org row, then cancel its billing (`org-teardown-core.ts`). */
  teardownOrg: (
    org: TeardownOrg,
    actor: { id: string | null; email: string | null; type: AuditActorType },
  ) => Promise<OrgTeardownResult>;
  getMembershipRole: (orgId: string, userId: string) => Promise<OrgRole | null>;
  /** Push the org's new seat count to its subscription after the initiator left.
   *  Never throws: a failed sync is recorded and reconciled later. */
  syncSeats: (orgId: string, trigger: "org.transfer_ownership") => Promise<unknown>;
  /** The last-admin-guarded removal (`set_membership` with no role). */
  deleteMembership: (orgId: string, userId: string) => Promise<MembershipMutationResult>;
  /** `false` = the row was not written. */
  recordAudit: (entry: AuditEntry) => Promise<boolean>;
  revalidate: (path: string) => void;
};

export function makeOrgActions(deps: OrgActionDeps) {
  const randomSuffix = deps.randomSuffix ?? (() => randomBytes(2).toString("hex"));

  /**
   * Self-serve "create another organisation" — any signed-in user, regardless of
   * their role in any org they already belong to, can start a brand new one and
   * becomes its Admin (mirrors `getOrCreateOrg`'s auto-provisioned personal-org
   * bootstrap). It only needs a signed-in identity.
   */
  async function createOrganisation(name: string): Promise<CreateOrgResult> {
    const user = await deps.getAuthenticatedUser();
    if (!user) return { ok: false, error: CREATE_SIGNED_OUT_ERROR };

    const limited = await deps.rateLimit("org:create", user.id, { limit: 10, windowMs: HOUR_MS });
    if (!limited.ok) return { ok: false, error: limited.error };

    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) return { ok: false, error: "Enter an organisation name." };

    const base = deps.slugify(trimmed);
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const org = await deps.insertOrg(candidate, trimmed);
      if (!org) continue; // slug collision — retry with a suffixed candidate

      const bootstrapped = await deps.insertBootstrapMembership(org.id, user.id);
      if (!bootstrapped) {
        await deps.deleteOrgRow(org.id);
        return { ok: false, error: "Could not create the organisation. Please try again." };
      }

      await deps.recordAudit({
        orgId: org.id,
        actorId: user.id,
        actorEmail: user.email ?? null,
        actorType: "member",
        action: "org.create",
        targetType: "org",
        targetId: org.id,
        targetLabel: org.github_login,
      });

      return { ok: true, slug: org.github_login };
    }

    return { ok: false, error: "Could not create the organisation. Please try again." };
  }

  /**
   * Permanently delete the organisation and all of its data. Every `org_id`
   * foreign key cascades on delete, so removing the `orgs` row wipes invites,
   * grants and usage in one statement; the subscription is cancelled only once
   * the row is gone (`org-teardown-core.ts`). The caller must re-type the org's
   * login to confirm (guards against accidental one-click loss). Admin only,
   * rate-limited.
   */
  async function deleteOrganisation(confirmation: string): Promise<DeleteOrganisationResult> {
    const guard = await deps.guard({
      require: allows("org.delete"),
      permissionError: PERMISSION_ERROR,
      signedOutError: SIGNED_OUT_ERROR,
    });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { membership } = guard;

    const expected = membership.org.github_login.trim().toLowerCase();
    if (confirmation.trim().toLowerCase() !== expected) {
      return {
        ok: false,
        error: `Type "${membership.org.github_login}" exactly to confirm deletion.`,
      };
    }

    // Rate-limited only AFTER the typed confirmation matches — the limit is scarce
    // (3/hour), and a typo must not burn an attempt.
    const limited = await deps.rateLimit("org:delete", membership.userId, {
      limit: 3,
      windowMs: HOUR_MS,
    });
    if (!limited.ok) return { ok: false, error: limited.error };

    // Record the deletion BEFORE anything changes. audit_log.org_id is `on delete
    // set null`, so this entry survives the cascade (its org_id is nulled) with the
    // org's login preserved in target_label — a deleted org still leaves a trace.
    // If that trace can't be written, nothing is deleted.
    const actor = await deps.getAuthenticatedUser();
    const entry = {
      orgId: membership.org.id,
      actorId: membership.userId,
      actorEmail: actor?.email ?? null,
      actorType: "member",
      targetType: "org",
      targetId: membership.org.id,
      targetLabel: membership.org.github_login,
    } as const;
    if (!(await deps.recordAudit({ ...entry, action: "org.delete" }))) {
      return { ok: false, error: "The audit record could not be written, so nothing was deleted." };
    }

    const teardown = await deps.teardownOrg(membership.org, {
      id: membership.userId,
      email: actor?.email ?? null,
      type: "member",
    });
    if (!teardown.ok) {
      // The org still exists, so its `org.delete` row must not stand alone.
      await deps.recordAudit({ ...entry, action: "org.delete_failed" });
      return { ok: false, error: "Could not delete the organisation. Please try again." };
    }

    deps.revalidate("/settings");
    deps.revalidate("/workspace");
    return teardown.subscriptionNotCancelled
      ? {
          ok: true,
          warning:
            "Organisation deleted, but we couldn't confirm its subscription was cancelled. Contact support so you aren't billed again.",
        }
      : { ok: true };
  }

  /**
   * Hand the organisation over to another Admin, then leave it. There is no
   * org-level owner — every Admin is an equal — so "transferring" means making
   * sure someone else is running the org and stepping out: the initiator's
   * membership is removed, and they keep whatever other orgs they belong to.
   *
   * The recipient must already be an Admin of THIS org (app-side tenancy — never
   * reach across orgs). The caller re-types the org's login to confirm (mirrors
   * `deleteOrganisation`). Admin only, rate-limited, and — like deletion — not run
   * at all when its audit record can't be written.
   *
   * Removing the initiator goes through the last-admin-guarded `set_membership`,
   * and the recipient is an Admin, so the org can never be left unmanaged.
   */
  async function transferOwnership(input: {
    userId: string;
    confirmation: string;
  }): Promise<OrgActionResult> {
    const guard = await deps.guard({
      require: allows("org.transfer"),
      permissionError: PERMISSION_ERROR,
      signedOutError: SIGNED_OUT_ERROR,
    });
    if (!guard.ok) return { ok: false, error: guard.error };
    const { membership } = guard;

    if (input.userId === membership.userId) {
      return { ok: false, error: "Choose another Admin to hand the organisation to." };
    }

    const expected = membership.org.github_login.trim().toLowerCase();
    if (input.confirmation.trim().toLowerCase() !== expected) {
      return {
        ok: false,
        error: `Type "${membership.org.github_login}" exactly to confirm the transfer.`,
      };
    }

    // As with deletion: consume the scarce limit only after the confirmation matches.
    const limited = await deps.rateLimit("org:transfer", membership.userId, {
      limit: 5,
      windowMs: HOUR_MS,
    });
    if (!limited.ok) return { ok: false, error: limited.error };

    const orgId = membership.org.id;
    // The recipient must already belong to THIS org — app-side tenancy, never reach
    // across orgs to hand the org to a stranger.
    const targetRole = await deps.getMembershipRole(orgId, input.userId);
    if (!targetRole) return { ok: false, error: "That person is not a member of this organisation." };
    if (targetRole !== "admin") {
      return { ok: false, error: "The organisation can only be handed to another Admin." };
    }

    const user = await deps.getAuthenticatedUser();
    const entry = {
      orgId,
      actorId: membership.userId,
      actorEmail: user?.email ?? null,
      actorType: "member",
      targetType: "member",
      targetId: input.userId,
    } as const;
    if (
      !(await deps.recordAudit({
        ...entry,
        action: "org.transfer_ownership",
        metadata: { previous_admin_left: true },
      }))
    ) {
      return {
        ok: false,
        error: "The audit record could not be written, so the organisation was not handed over.",
      };
    }

    const left = await deps.deleteMembership(orgId, membership.userId);
    if (left !== "ok") {
      // The initiator is still a member, so the transfer row must not stand alone.
      await deps.recordAudit({ ...entry, action: "org.transfer_failed", metadata: { reason: left } });
      return { ok: false, error: "Could not transfer the organisation. Please try again." };
    }

    await deps.syncSeats(orgId, "org.transfer_ownership");

    deps.revalidate("/settings");
    return { ok: true };
  }

  return { createOrganisation, deleteOrganisation, transferOwnership };
}
