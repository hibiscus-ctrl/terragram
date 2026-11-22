"use client";

import { useState } from "react";
import { ArrowDownToLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Downgrade Team/PAYG → OSS. The cancellation itself happens in the Stripe Customer
 * Portal — it owns proration, the final invoice and the cancel webhook that flips
 * `orgs.plan` back to OSS (`setOrgPlanFromSubscription`). This button makes that path
 * discoverable from the OSS plan card and spells out exactly what changes before
 * sending the user there, so "how do I go back to OSS?" has an obvious answer.
 */
export function DowngradeToOssButton() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" className="mt-3.5" onClick={() => setOpen(true)}>
        <ArrowDownToLine className="size-3.5" strokeWidth={1.8} aria-hidden /> Downgrade to OSS
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => !pending && setOpen(o)}
        title="Downgrade to OSS?"
        description={
          <>
            You stay on your current plan until the end of the billing period, then move to OSS with
            no further charges. Public repositories stay free, your run history and compliance
            evidence are kept, and managed models switch off. Private-repo findings lock until you
            upgrade again.
            <br />
            <br />
            We&rsquo;ll take you to the billing portal to confirm the cancellation and download any
            final invoice.
          </>
        }
        confirmLabel="Continue to billing portal"
        pending={pending}
        onConfirm={() => {
          setPending(true);
          // `/manage-subscription` is a route handler that opens the Stripe portal, so
          // navigate the whole page rather than client-routing to it.
          window.location.href = "/manage-subscription";
        }}
      />
    </>
  );
}
