// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { formatGbp } from "@/config/pricing";
import { createCreditTopupCheckout } from "@/features/billing/actions/credit-topup";
import {
  MAX_TOPUP_PENCE,
  MIN_TOPUP_PENCE,
  normalizeTopupPence,
  TOPUP_PRESETS_PENCE,
} from "@/features/billing/credit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MIN_POUNDS = MIN_TOPUP_PENCE / 100;
const MAX_POUNDS = MAX_TOPUP_PENCE / 100;

/**
 * Buy prepaid credit. A quick-pick preset or a free-entry amount both start a one-off
 * Stripe Checkout (the action `redirect()`s there, so it never returns on success).
 * The paid amount lands as customer credit via the webhook and is drawn down against
 * future invoices before the card is charged. The custom amount is validated against
 * the same `normalizeTopupPence` bounds the server enforces, so an out-of-range value
 * can't reach Checkout.
 */
export function TopUpCreditButton() {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [pending, startTransition] = useTransition();

  // Custom input is in pounds; convert to pence and reuse the shared validator so the
  // button enables only for an amount the action will accept.
  const customPence = custom.trim() === "" ? null : normalizeTopupPence(Number(custom) * 100);

  const buy = (pence: number) =>
    startTransition(async () => {
      const res = await createCreditTopupCheckout(pence);
      if (res && !res.ok) {
        toast.error(res.error);
        setOpen(false);
      }
    });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> Add credit
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Add prepaid credit</DialogTitle>
            <DialogDescription>
              Credit is applied to your Terragram invoices before your card is charged. Pick a
              preset or enter your own amount.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2.5">
            {TOPUP_PRESETS_PENCE.map((pence) => (
              <Button key={pence} variant="outline" disabled={pending} onClick={() => buy(pence)}>
                {formatGbp(pence)}
              </Button>
            ))}
          </div>

          <div className="text-2xs text-muted-foreground flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            or enter an amount
            <span className="bg-border h-px flex-1" />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (customPence !== null) buy(customPence);
            }}
          >
            <label htmlFor="topup-custom" className="sr-only">
              Custom amount in pounds
            </label>
            <div className="flex items-stretch gap-2">
              <div className="relative flex-1">
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                  £
                </span>
                <input
                  id="topup-custom"
                  type="number"
                  inputMode="decimal"
                  min={MIN_POUNDS}
                  max={MAX_POUNDS}
                  step="1"
                  placeholder="50"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  disabled={pending}
                  className="border-input focus-visible:border-primary bg-surface-subtle text-secondary-foreground w-full rounded-lg border py-2.5 pr-3.5 pl-7 text-sm tabular-nums outline-none"
                />
              </div>
              <Button type="submit" disabled={pending || customPence === null}>
                {customPence !== null ? `Add ${formatGbp(customPence)}` : "Add"}
              </Button>
            </div>
            <p className="text-muted-foreground mt-1.5 text-2xs">
              Any amount from {formatGbp(MIN_TOPUP_PENCE)} to {formatGbp(MAX_TOPUP_PENCE)}. Need more?{" "}
              <Link href="/contact" className="text-primary font-medium hover:underline">
                Contact us
              </Link>
              .
            </p>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
