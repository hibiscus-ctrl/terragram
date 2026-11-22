// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState, useTransition } from "react";
import { Cpu } from "lucide-react";
import { toast } from "sonner";

import { setManagedModelsOptOut } from "@/features/billing/actions/managed-opt-out";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Disable / re-enable managed models for an org that already has an active
 * subscription (so no Checkout is needed — it only flips `orgs.managed_opt_out`).
 * Disabling asks for confirmation because it changes how keyless runs resolve a
 * model; re-enabling is a plain one-click.
 */
export function ManagedModelsToggle({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const apply = (optOut: boolean) =>
    startTransition(async () => {
      const res = await setManagedModelsOptOut(optOut);
      if (!res.ok) toast.error(res.error ?? "Could not update managed models.");
      setConfirmOpen(false);
    });

  if (!enabled) {
    return (
      <Button variant="outline" size="sm" loading={pending} onClick={() => apply(false)}>
        {!pending && <Cpu className="size-4" aria-hidden />}
        Enable managed models
      </Button>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
        Disable managed models
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disable managed models"
        description="Keyless CI runs will use the free fallback model instead of our managed Bedrock models (UK & EU), and nothing will meter. You keep your plan and can re-enable any time. Runs that supply their own model key are unaffected."
        confirmLabel="Disable"
        pending={pending}
        onConfirm={() => apply(true)}
      />
    </>
  );
}
