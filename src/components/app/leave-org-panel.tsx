// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";

import { OrgSwitcher } from "@/components/app/org-switcher";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { leaveOrganisation } from "@/features/app/member-actions";
import type { LeaveView } from "@/features/app/reads/members";

/**
 * The caller's organisation and the way out of it. Any role may leave, so this
 * sits on the one settings page every member can open; the last Admin is told why
 * not instead of being offered a button that will be refused. A member of several
 * orgs can switch the active one here too, whatever their role in this one.
 */
export function LeaveOrgPanel({ view }: { view: LeaveView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function leave() {
    startTransition(async () => {
      const res = await leaveOrganisation();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setOpen(false);
      toast.success(`You left ${view.orgLabel}.`);
      router.push("/workspace");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="organisation-heading" className="mt-10">
      <h2 id="organisation-heading" className="text-base font-bold text-foreground">
        Organisation
      </h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-strong bg-card p-4">
        <div>
          <div className="text-sm font-semibold text-foreground">
            You are {/^[AEIOU]/.test(view.role) ? "an" : "a"} {view.role} of{" "}
            <span className="font-mono">{view.orgLabel}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {view.blockedBy ??
              "Leaving ends your access to its settings and billing. Your workspaces stay yours."}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view.orgs.length > 1 && (
            <OrgSwitcher
              orgs={view.orgs}
              activeOrgId={view.orgId}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              Switch organisation
              <ChevronsUpDown className="size-3.5" aria-hidden />
            </OrgSwitcher>
          )}
          <Button
            variant="outline"
            size="sm"
            className="border-danger-border text-danger hover:bg-danger-bg"
            disabled={view.blockedBy !== null}
            onClick={() => setOpen(true)}
          >
            Leave organisation
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Leave ${view.orgLabel}?`}
        description="You lose access to the organisation straight away. Your own workspaces are not affected, and an Admin can invite you back."
        confirmLabel="Leave organisation"
        destructive
        pending={pending}
        onConfirm={leave}
      />
    </section>
  );
}
