// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useTransition } from "react";
import { Cpu } from "lucide-react";
import { toast } from "sonner";

import { createOrgUpgradeCheckout } from "@/features/billing/actions/upgrade-checkout";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/cn";

/**
 * Opt an OSS org into managed models (PAYG): a £0 base + the metered managed line.
 * Calls the shared upgrade action with `tier: 'payg'`, which redirects to Stripe
 * Checkout to collect a card (or switches the line in place if a card is already
 * on file). On failure the action returns and we toast it.
 */
export function EnableManagedModelsButton({ className }: { className?: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(className)}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await createOrgUpgradeCheckout({ tier: "payg" });
          if (res && !res.ok) toast.error(res.error);
        })
      }
    >
      {!pending && <Cpu className="size-4" aria-hidden />}
      Enable managed models
    </Button>
  );
}
