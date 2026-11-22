// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createShareLinkAction,
  listShareLinksAction,
  revokeShareLinkAction,
} from "@/features/workspace/actions";
import type { ShareLink } from "@/features/workspace/store";
import { formatDate } from "@/utils/format-date";

/**
 * Read-only review links.
 *
 * The review gate implies a second person, and until now no one but the owner could
 * see a workspace at all. A link lets a reviewer read the diagram, the plan and the
 * receipts; it can never approve, edit or generate. Links expire, can be revoked, and
 * the token is shown exactly once because only its hash is stored.
 */
export function ShareMenu({ workspaceId }: { workspaceId: string }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(open: boolean) {
    if (!open) return;
    setLinks(null);
    try {
      setLinks(await listShareLinksAction(workspaceId));
    } catch {
      setLinks([]);
    }
  }

  async function mint() {
    setBusy(true);
    const link = await createShareLinkAction(workspaceId);
    setBusy(false);
    if (!link?.token) {
      toast.error("Couldn’t create a link", {
        description: "Sharing needs the workspace tables applied.",
      });
      return;
    }
    const url = `${window.location.origin}/shared/${link.token}`;
    setMinted(url);
    setLinks(await listShareLinksAction(workspaceId));
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Review link copied", { description: "Read-only, and expires in 14 days." });
    } catch {
      toast.success("Review link created", { description: "Copy it below — it is shown once." });
    }
  }

  async function revoke(id: string) {
    await revokeShareLinkAction(id);
    setLinks(await listShareLinksAction(workspaceId));
    setMinted(null);
    toast.success("Link revoked");
  }

  const active = (links ?? []).filter(
    (l) => l.revokedAt === null && new Date(l.expiresAt).getTime() > Date.now(),
  );

  return (
    <DropdownMenu onOpenChange={load}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 font-mono text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <Share2 className="size-3" aria-hidden /> Share
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Share for review</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Anyone with the link can read this workspace. They cannot edit it, approve
            anything, or generate code.
          </p>
          {minted && (
            <p className="mt-2 rounded-md border border-line bg-background p-2 font-mono text-2xs break-all text-foreground">
              {minted}
            </p>
          )}
          <Button size="sm" className="mt-2 w-full" onClick={() => void mint()} disabled={busy}>
            {busy ? "Creating…" : "Create review link"}
          </Button>
        </div>
        {active.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">
              Active links · {active.length}
            </DropdownMenuLabel>
            <ul className="px-2 pb-2">
              {active.map((link) => (
                <li key={link.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="font-mono text-2xs text-muted-foreground">
                    expires {formatDate(link.expiresAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void revoke(link.id)}
                    className="rounded px-1.5 py-0.5 font-mono text-2xs text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
