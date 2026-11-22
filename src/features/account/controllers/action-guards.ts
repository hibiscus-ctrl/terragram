// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { rateLimit, retryAfterLabel } from "@/libs/rate-limit";

import {
  getCurrentMembership,
  getOrCreateMembership,
  type OrgMembership,
  type OrgRole,
} from "./get-or-create-org";

/**
 * The action-side analogue of `page-guards.ts` and the API path's `makeWithAuth`:
 * every dashboard server action resolves membership, checks the role, and (usually)
 * rate-limits through this ONE preamble instead of re-inlining the three steps.
 * The role matrix itself stays in `permissions.ts` — pass `allows(capability)` in.
 */

export type ActionGuardFailure = {
  ok: false;
  /** Lets a caller special-case signed-out (e.g. the token actions' demo no-op). */
  reason: "signed-out" | "forbidden" | "rate-limited";
  error: string;
};

export type ActionGuardResult = { ok: true; membership: OrgMembership } | ActionGuardFailure;

/** Per-user rate limit with the standard "Try again in …" suffix. Exported for
 *  actions that must consume the limit at a later point than the guard (e.g. after
 *  a typed-confirmation check, so a typo can't burn a scarce attempt). */
export type ActionRateLimitOptions = {
  limit: number;
  windowMs: number;
  message?: string;
  failClosed?: boolean;
};

export async function actionRateLimit(
  name: string,
  userId: string,
  opts: ActionRateLimitOptions,
): Promise<{ ok: true } | ActionGuardFailure> {
  const limit = await rateLimit(`${name}:${userId}`, {
    limit: opts.limit,
    windowMs: opts.windowMs,
    ...(opts.failClosed ? { failClosed: true } : {}),
  });
  if (limit.ok) return { ok: true };
  const retry = retryAfterLabel(limit.retryAfterMs);
  return {
    ok: false,
    reason: "rate-limited",
    error: `${opts.message ?? "Too many requests."} Try again in ${retry}.`,
  };
}

export type GuardMemberActionOptions = {
  /** `allows(capability)` from `permissions.ts`; omitted = any signed-in member. */
  require?: (role: OrgRole) => boolean;
  /** Surfaced when the role check fails (also the signed-out default). */
  permissionError: string;
  /** Surfaced when there is no membership, when it should differ from the role error. */
  signedOutError?: string;
  /** Provision a personal org on first use (`getOrCreateMembership`). */
  provision?: boolean;
  /** Per-user rate limit, keyed `<name>:<userId>`. */
  rateLimit?: { name: string } & ActionRateLimitOptions;
};

export async function guardMemberAction(
  opts: GuardMemberActionOptions,
): Promise<ActionGuardResult> {
  const membership = opts.provision
    ? await getOrCreateMembership()
    : await getCurrentMembership();
  if (!membership) {
    return {
      ok: false,
      reason: "signed-out",
      error: opts.signedOutError ?? opts.permissionError,
    };
  }
  if (opts.require && !opts.require(membership.role)) {
    return { ok: false, reason: "forbidden", error: opts.permissionError };
  }
  if (opts.rateLimit) {
    const limited = await actionRateLimit(opts.rateLimit.name, membership.userId, opts.rateLimit);
    if (!limited.ok) return limited;
  }
  return { ok: true, membership };
}
