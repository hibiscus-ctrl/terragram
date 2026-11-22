// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { bandedTotalPence, entryRatePence, formatGbp, formatGbpAmount } from "@/config/pricing";
import { createOrgUpgradeCheckout } from "@/features/billing/actions/upgrade-checkout";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/utils/cn";

/**
 * Upgrade to Team. Always confirms the expected cost first — when a card is already
 * on file the server swaps the plan in place (no Stripe Checkout step), so this
 * dialog is the only place the charge is shown before it happens. On confirm the
 * action `redirect()`s (to Stripe Checkout, or back to /billing after an in-place
 * swap), so it never returns on success; a failure is surfaced as a toast.
 *
 * `seats` lets the dialog show a concrete monthly estimate; when it is not known
 * the copy falls back to the per-seat rate.
 */
export function UpgradeButton({
  label = "Upgrade to unlock",
  className,
  seats,
}: {
  label?: string;
  className?: string;
  seats?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const entryRate = entryRatePence("month");
  const estimatePence =
    seats != null && seats >= 1 ? bandedTotalPence(seats, "month") : null;

  const description = (
    <>
      Team unlocks Terraform output, the review gate and the signed evidence store. It&rsquo;s
      billed per seat at {formatGbp(entryRate)}/seat/mo, with marginal bands down to £8.{" "}
      {estimatePence !== null ? (
        <>
          Your {seats} seat{seats === 1 ? "" : "s"} come to about{" "}
          <strong>{formatGbpAmount(estimatePence)}/mo</strong>.
        </>
      ) : (
        <>Each seat includes a monthly allowance of managed inference.</>
      )}{" "}
      The change is prorated for the rest of this billing cycle and charged to your card on file.
    </>
  );

  return (
    <>
      <Button className={cn(className)} loading={pending} onClick={() => setOpen(true)}>
        {!pending && <Sparkles className="size-4" aria-hidden />}
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Upgrade to Team"
        description={description}
        confirmLabel="Upgrade to Team"
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const res = await createOrgUpgradeCheckout({ tier: "team" });
            if (res && !res.ok) {
              toast.error(res.error);
              setOpen(false);
            }
          })
        }
      />
    </>
  );
}
