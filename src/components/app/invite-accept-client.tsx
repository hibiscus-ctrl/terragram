// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type ReactNode, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheck, TriangleAlert, Users } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ROLE_LABEL } from "@/features/account/controllers/permissions";
import { acceptInvite } from "@/features/app/member-actions";
import type { InvitePreview } from "@/features/app/invites";
import { cn } from "@/utils/cn";

type Notice = { title: string; body: string; tone: "ok" | "fail" };

/** Why a link can't be used, from the preview or from a refused acceptance. */
const UNUSABLE: Record<"invalid" | "expired" | "accepted", Notice> = {
  invalid: {
    title: "Invitation not found",
    body: "This invite link is not valid. Ask an Admin of the organisation for a new one.",
    tone: "fail",
  },
  expired: {
    title: "Invitation expired",
    body: "This invitation has expired. Ask an Admin of the organisation for a new one.",
    tone: "fail",
  },
  accepted: {
    title: "Invitation already used",
    body: "This invite link has already been accepted. Each link works once.",
    tone: "fail",
  },
};

function Card({ tone, children }: { tone: "ok" | "fail" | "neutral"; children: ReactNode }) {
  const Icon = tone === "fail" ? TriangleAlert : tone === "ok" ? CircleCheck : Users;
  return (
    <div className="w-full max-w-[420px] rounded-2xl border border-border bg-card p-8 text-center">
      <span
        className={cn(
          "mx-auto mb-4 flex size-12 items-center justify-center rounded-full",
          tone === "fail" ? "bg-danger-bg text-danger" : "bg-surface text-surface-foreground",
        )}
      >
        <Icon className="size-6" strokeWidth={1.7} aria-hidden />
      </span>
      {children}
    </div>
  );
}

function NoticeCard({ notice, signedIn }: { notice: Notice; signedIn: boolean }) {
  return (
    <Card tone={notice.tone}>
      <h1 className="text-lg font-bold tracking-[-0.02em]">{notice.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{notice.body}</p>
      <Button asChild variant="outline" className="mt-6">
        <Link href={signedIn ? "/workspace" : "/"}>{signedIn ? "Open the workspace" : "Go to Terragram"}</Link>
      </Button>
    </Card>
  );
}

/**
 * The `/invite/[token]` page body. A signed-out visitor sees who invited them
 * where, and signs in with this link as the place to come back to; a signed-in one
 * accepts. The token is the credential, so nothing here reveals more than the org
 * and the role it grants.
 */
export function InviteAcceptClient({
  token,
  preview,
  signedIn,
}: {
  token: string;
  preview: InvitePreview;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refused, setRefused] = useState<Notice | null>(null);

  if (refused) return <NoticeCard notice={refused} signedIn={signedIn} />;

  if (preview.status === "already-member") {
    return (
      <NoticeCard
        notice={{
          title: `You're in ${preview.orgLabel}`,
          body: `You are already a member of ${preview.orgLabel}, so there is nothing to accept.`,
          tone: "ok",
        }}
        signedIn={signedIn}
      />
    );
  }
  if (preview.status !== "valid") return <NoticeCard notice={UNUSABLE[preview.status]} signedIn={signedIn} />;

  const role = ROLE_LABEL[preview.role];
  const intro = (
    <>
      <h1 className="text-lg font-bold tracking-[-0.02em]">Join {preview.orgLabel}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {preview.invitedBy ? `${preview.invitedBy} invited you` : "You've been invited"} to{" "}
        <strong className="text-foreground">{preview.orgLabel}</strong> as{" "}
        {/^[AEIOU]/.test(role) ? "an" : "a"} <strong className="text-foreground">{role}</strong>.
      </p>
    </>
  );

  if (!signedIn) {
    const next = encodeURIComponent(`/invite/${token}`);
    return (
      <Card tone="neutral">
        {intro}
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Sign in to accept. If you sign in with the address this invitation was sent to, you join
          automatically.
        </p>
        <Button asChild variant="dark" className="mt-6 w-full">
          <Link href={`/login?next=${next}`}>Sign in to accept</Link>
        </Button>
        <p className="mt-4 text-xs text-muted-foreground">
          New to Terragram?{" "}
          <Link href={`/signup?next=${next}`} className="font-semibold text-primary hover:underline">
            Create an account
          </Link>{" "}
          with the invited address.
        </p>
      </Card>
    );
  }

  function accept() {
    startTransition(async () => {
      // A thrown action (network drop, a 500) must surface, not leave the button idle.
      try {
        const result = await acceptInvite(token);
        switch (result.status) {
          case "joined":
          case "already-member":
            toast.success(`You joined ${result.orgLabel}`);
            router.push("/workspace");
            router.refresh();
            return;
          case "role-unavailable":
            setRefused({ title: "Role not available", body: result.error, tone: "fail" });
            return;
          case "signed-out":
            setRefused({
              title: "Signed out",
              body: "Your session has ended. Sign in again and reopen this link.",
              tone: "fail",
            });
            return;
          default:
            setRefused(UNUSABLE[result.status]);
        }
      } catch {
        toast.error("Could not accept the invitation. Please try again.");
      }
    });
  }

  return (
    <Card tone="neutral">
      {intro}
      <Button variant="dark" className="mt-6 w-full" onClick={accept} loading={pending}>
        Accept invitation
      </Button>
    </Card>
  );
}
