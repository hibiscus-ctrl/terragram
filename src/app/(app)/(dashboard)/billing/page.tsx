// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, Clock, CreditCard, Lock, ShieldCheck, TriangleAlert } from "lucide-react";

import {
  entryRatePence,
  formatGbp,
  formatGbpAmount,
  managedAllowancePerSeatPence,
} from "@/config/pricing";
import { guardPage } from "@/features/account/controllers/page-guards";
import { getCurrentOrg } from "@/features/account/controllers/get-or-create-org";
import { flushUsageOnView } from "@/features/billing/metering";
import { type SeatSyncOutcome, syncOrgSeats } from "@/features/billing/seat-sync";
import { DemoBadge } from "@/components/app/demo-badge";
import { DowngradeToOssButton } from "@/components/app/downgrade-to-oss-button";
import { EnableManagedModelsButton } from "@/components/app/enable-managed-models-button";
import { ManagedModelsToggle } from "@/components/app/managed-models-toggle";
import { TopUpCreditButton } from "@/components/app/top-up-credit-button";
import { UpgradeButton } from "@/components/app/upgrade-button";
import { Button } from "@/components/ui/button";
import { getBillingView } from "@/features/app/reads/billing";
import { cn } from "@/utils/cn";

export const metadata: Metadata = { title: "Billing & usage" };
export const dynamic = "force-dynamic";

const planTiers: {
  name: string;
  price: string;
  unit?: string;
  note: string;
  body: string;
  contact?: boolean;
  /** OSS is the downgrade target — shows the "Downgrade to OSS" affordance when on a paid plan. */
  downgrade?: boolean;
}[] = [
  {
    name: "OSS",
    price: "£0",
    note: "self-host · free Cloud",
    body: "Public-repo dashboard & history · managed models opt-in",
    downgrade: true,
  },
  {
    name: "Team",
    price: `from ${formatGbp(entryRatePence())}`,
    unit: "/repo/mo",
    note: "marginal bands to £8",
    body: "Private repos · maintained crosswalk · evidence store · SAML SSO · auditor role",
  },
  {
    name: "Enterprise",
    price: "Custom",
    note: "dedicated · managed",
    body: "Everything in Team · dedicated single-tenant instance · DPA & residency · priority SLA",
    contact: true,
  },
];

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string; topup?: string }>;
}) {
  await guardPage("billing.manage");
  // Report the metered backlog to Stripe while the org is here, throttled per org.
  // This does NOT move the numbers below — they read the local ledger and are
  // already current. It moves when that usage reaches an invoice, which the
  // subscription webhook would otherwise decide on its own schedule.
  //
  // The view also reconciles the seat quantity: a sync that failed when a member
  // joined or left is retried here, and one that still fails is shown below.
  const viewingOrg = await getCurrentOrg();
  let seatSync: SeatSyncOutcome = { status: "skipped" };
  if (viewingOrg) {
    [, seatSync] = await Promise.all([
      flushUsageOnView(viewingOrg.id),
      syncOrgSeats(viewingOrg.id, "billing_view"),
    ]);
  }
  const {
    planLabel,
    planActive,
    privateUnlocked,
    seats,
    bandedChargePence,
    managedCostPence,
    meteredCostPence,
    hasActiveSub,
    managedModelsEnabled,
    hasBilling,
    creditBalancePence,
    cancelAtPeriodEnd,
    planEndsAtIso,
    demo,
  } = await getBillingView();
  const params = await searchParams;
  // Show the "activating" banner only while the thing it announces is still pending,
  // so it clears the instant the webhook lands (and on any later refresh) instead of
  // sticking around because `?upgraded=…` is still in the URL.
  const teamActivating =
    (params.upgraded === "team" || params.upgraded === "1") && !privateUnlocked;
  const managedActivating = params.upgraded === "managed" && !managedModelsEnabled;
  const toppedUp = params.topup === "success";

  // Managed-usage progress only has meaning against an included allowance; when the
  // allowance is zero there is nothing to be a percentage of, so we hide the bar.
  const allowancePence = managedAllowancePerSeatPence() * seats;
  const usagePct =
    allowancePence > 0
      ? Math.min(100, Math.round((managedCostPence / allowancePence) * 100))
      : null;
  const allowanceUsedPence = Math.max(0, managedCostPence - meteredCostPence);

  // Which catalog card is "current": the mock highlights Team; a real org uses its
  // resolved tier label (OSS / Pay-as-you-go / Team / Enterprise).
  const currentTier = demo ? "Team" : planLabel;

  // A scheduled downgrade keeps the plan active until this date — show it so the still-
  // active plan reads as intentional rather than a downgrade that "didn't work".
  const scheduledDowngrade = cancelAtPeriodEnd && !demo;
  const planEndsLabel = planEndsAtIso
    ? new Date(planEndsAtIso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div className="w-full px-4 pt-6 pb-16 sm:px-8 sm:pt-8">
      <div className="mb-1 flex items-center gap-2.5">
        <CreditCard className="size-6 text-muted-foreground" strokeWidth={1.7} aria-hidden />
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-[-0.025em]">
          Billing &amp; usage
          {demo && <DemoBadge />}
        </h1>
      </div>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Plan, managed-model metering and invoices
      </p>

      {teamActivating && (
        <div className="border-success-border bg-success-bg text-success mb-5 flex items-center gap-3 rounded-lg border px-5 py-3.5 text-xs font-medium">
          <CircleCheck className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
          Thanks — your plan is being activated. Private repositories unlock as soon as Stripe
          confirms (usually seconds).
        </div>
      )}
      {managedActivating && (
        <div className="border-success-border bg-success-bg text-success mb-5 flex items-center gap-3 rounded-lg border px-5 py-3.5 text-xs font-medium">
          <CircleCheck className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
          Thanks — managed models are being enabled. They&rsquo;ll be ready as soon as Stripe
          confirms (usually seconds).
        </div>
      )}
      {toppedUp && (
        <div className="border-success-border bg-success-bg text-success mb-5 flex items-center gap-3 rounded-lg border px-5 py-3.5 text-xs font-medium">
          <CircleCheck className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
          Payment received — your prepaid credit will appear on your balance in a moment.
        </div>
      )}

      {seatSync.status === "failed" && (
        <div
          role="status"
          className="border-warning-border bg-warning-bg text-warning mb-5 flex items-center gap-3 rounded-lg border px-5 py-3.5 text-xs font-medium"
        >
          <TriangleAlert className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
          <span>
            <span className="font-semibold">Seat count out of sync.</span>{" "}
            {seatSync.seats !== null && seatSync.quantity !== null
              ? `Your organisation has ${seatSync.seats} ${seatSync.seats === 1 ? "member" : "members"}, but the Team subscription bills ${seatSync.quantity} ${seatSync.quantity === 1 ? "seat" : "seats"}. `
              : "We could not confirm that the Team subscription bills your current member count. "}
            It is retried automatically, including the next time this page opens. If this stays,
            contact support.
          </span>
        </div>
      )}

      {scheduledDowngrade && (
        <div className="border-line-strong bg-surface-sunken text-muted-foreground mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-5 py-3.5 text-xs">
          <div className="flex items-center gap-3">
            <Clock className="text-primary size-4 shrink-0" strokeWidth={1.8} aria-hidden />
            <span>
              Your <span className="font-semibold">{planLabel}</span> plan is scheduled to end
              {planEndsLabel ? (
                <>
                  {" "}
                  on <span className="font-semibold">{planEndsLabel}</span>
                </>
              ) : (
                " at the end of this billing period"
              )}
              . You stay on {planLabel} with full access until then, then move to OSS — no further
              charges. Changed your mind? Resume from the billing portal.
            </span>
          </div>
          {hasBilling && (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              {/* oxlint-disable-next-line no-html-link-for-pages -- must NOT be a Link. /manage-subscription is a route handler that
                  opens a Stripe billing-portal session and redirects; Link would prefetch it on
                  hover and mint portal sessions nobody asked for. */}
              <a href="/manage-subscription">Manage billing</a>
            </Button>
          )}
        </div>
      )}

      {!privateUnlocked && !demo && (
        <div className="border-line-strong bg-surface-sunken mb-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border px-6 py-5">
          <div className="flex items-center gap-3.5">
            <span className="bg-surface text-surface-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
              <Lock className="size-5" strokeWidth={1.7} aria-hidden />
            </span>
            <div>
              <div className="text-sm font-bold">Unlock private repositories</div>
              <div className="mt-0.5 max-w-[560px] text-xs leading-relaxed text-muted-foreground">
                Public repos are always free. Team unlocks findings, ✗→✓ proofs and the compliance
                evidence store for your private repos across the organisation.
              </div>
            </div>
          </div>
          <UpgradeButton label="Upgrade" className="shrink-0" seats={seats} />
        </div>
      )}

      {/* Current plan + managed models */}
      <div className="mb-4 grid items-start gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="bg-surface text-surface-foreground rounded-xl px-6 py-5">
          <div className="mb-3.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-surface-muted text-xs font-semibold">Current plan</span>
              {(demo || planActive) && (
                <span className="bg-success text-2xs rounded-full px-2 py-0.5 font-bold text-white">
                  ACTIVE
                </span>
              )}
              {scheduledDowngrade && (
                <span className="bg-surface-border text-surface-foreground text-2xs inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold">
                  <Clock className="size-3" strokeWidth={2} aria-hidden />
                  {planEndsLabel ? `Ends ${planEndsLabel}` : "Ending"}
                </span>
              )}
            </div>
            {!demo && hasBilling && (
              <Button asChild variant="surface-outline" size="sm">
                {/* oxlint-disable-next-line no-html-link-for-pages -- must NOT be a Link — prefetch
                    would mint a Stripe billing-portal session on hover. See the note above. */}
                <a href="/manage-subscription">
                  <CreditCard className="size-4" aria-hidden /> Manage billing
                </a>
              </Button>
            )}
          </div>
          <div className="mb-4 text-2xl font-extrabold tracking-[-0.02em]">
            {demo ? "Team" : planLabel}
          </div>
          <div className="flex flex-wrap gap-x-9 gap-y-3">
            {[
              { label: "Seats", value: demo ? "8" : String(seats) },
              {
                label: "Team charge",
                value: demo ? "—" : `${formatGbpAmount(bandedChargePence)}/mo`,
              },
              {
                label: "Managed spend · cycle",
                value: demo ? "—" : formatGbpAmount(managedCostPence),
              },
            ].map((c) => (
              <div key={c.label}>
                <div className="text-2xs text-surface-muted mb-1">{c.label}</div>
                <div className="font-mono text-lg font-bold">{c.value}</div>
              </div>
            ))}
          </div>
          {!demo && allowancePence > 0 && (
            <div className="mt-4">
              <div className="text-2xs text-surface-muted mb-1 flex justify-between">
                <span>Included allowance</span>
                <span>
                  {formatGbpAmount(allowanceUsedPence)} / {formatGbpAmount(allowancePence)}
                  {meteredCostPence > 0 && ` · ${formatGbpAmount(meteredCostPence)} billable`}
                </span>
              </div>
              <div className="h-[6px] overflow-hidden rounded-sm bg-white/10">
                <div className="bg-success h-full rounded-sm" style={{ width: `${usagePct ?? 0}%` }} />
              </div>
            </div>
          )}
          <div className="text-2xs text-surface-muted mt-4">
            Cycle resets 1 Jul · metered to Stripe
          </div>
        </div>
        <div className="border-border bg-card rounded-xl border px-6 py-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold">
              <ShieldCheck className="text-success size-4" strokeWidth={1.6} aria-hidden /> Managed
              models
            </div>
            {demo || managedModelsEnabled ? (
              <span className="border-success-border bg-success-bg text-2xs text-success inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-semibold">
                <span className="bg-success size-1.5 rounded-full" /> Enabled · UK (London)
              </span>
            ) : (
              <span className="border-border bg-surface-sunken text-2xs text-muted-foreground rounded-md border px-2.5 py-1 font-semibold">
                {hasActiveSub ? "Disabled" : "Not enabled"}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mb-3.5 text-xs leading-relaxed">
            Pay-as-you-go — our Bedrock cost + ~15%, no base fee. Inference is European — AWS
            Bedrock (UK &amp; EU) — under the DPA. Bring your own key and nothing meters.
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            {!demo && !hasActiveSub && <EnableManagedModelsButton />}
            {!demo && hasActiveSub && <ManagedModelsToggle enabled={managedModelsEnabled} />}
            {!demo && <TopUpCreditButton />}
            {!demo && (
              <span className="text-2xs text-muted-foreground ml-auto">
                Prepaid credit{" "}
                <span className="text-foreground font-mono text-sm font-bold">
                  {formatGbpAmount(creditBalancePence)}
                </span>
              </span>
            )}
          </div>
          {!demo && managedModelsEnabled && (
            <p className="text-2xs text-muted-foreground mt-2.5">
              £0 unless a keyless run uses managed models.
            </p>
          )}
        </div>
      </div>

      {/* How each run picks its model — full-width row */}
      <div className="border-border bg-card mb-6 rounded-xl border px-6 py-4">
        <div className="text-2xs text-muted-foreground mb-3 font-bold tracking-[0.04em] uppercase">
          How each run picks its model
        </div>
        <div className="text-muted-foreground grid gap-x-8 gap-y-2.5 text-xs leading-relaxed sm:grid-cols-3">
          <div>
            <span className="font-semibold text-secondary-foreground">Your own model key in CI</span> → runs on
            your key. Nothing meters.
          </div>
          <div>
            <span className="font-semibold text-secondary-foreground">No key, managed models on</span> → routes
            through our Bedrock proxy. Metered (Bedrock cost + ~15%).
          </div>
          <div>
            <span className="font-semibold text-secondary-foreground">No key, managed models off</span> → uses
            the free fallback model. Nothing meters.
          </div>
        </div>
      </div>

      {/* Plans */}
      <div className="mb-3.5 text-sm font-bold">Plans</div>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        {planTiers.map((t) => {
          const isCurrent = t.name === currentTier;
          return (
            <div
              key={t.name}
              className={cn(
                "bg-card flex flex-col rounded-xl border p-5",
                isCurrent ? "border-primary relative border-2 bg-surface-subtle" : "border-border",
              )}
            >
              {isCurrent && (
                <span className="bg-primary text-2xs absolute -top-2.5 right-4 rounded-full px-2.5 py-0.5 font-bold text-white">
                  CURRENT
                </span>
              )}
              <div className="mb-1 flex items-center gap-1.5 text-sm font-bold">
                {t.name}
              </div>
              <div className="mb-0.5 text-2xl font-extrabold">
                {t.price}
                {t.unit && (
                  <span className="text-muted-foreground text-xs font-medium">{t.unit}</span>
                )}
              </div>
              <div className="text-muted-foreground mb-3.5 text-xs">{t.note}</div>
              <div className="text-muted-foreground flex-1 text-xs leading-relaxed">{t.body}</div>
              {t.contact && (
                <Button variant="outline" size="sm" className="mt-3.5" asChild>
                  <Link href="/contact">Contact us</Link>
                </Button>
              )}
              {t.downgrade &&
                !demo &&
                (privateUnlocked || hasActiveSub) &&
                hasBilling &&
                (scheduledDowngrade ? (
                  <p className="text-muted-foreground mt-3.5 flex items-center gap-1.5 text-2xs">
                    <Clock className="size-3 shrink-0" strokeWidth={2} aria-hidden />
                    {planEndsLabel ? `Scheduled for ${planEndsLabel}` : "Downgrade scheduled"}
                  </p>
                ) : (
                  <DowngradeToOssButton />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
