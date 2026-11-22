// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { listSnapshotsAction, restoreSnapshotAction } from "@/features/workspace/actions";
import type { InfraModel } from "terragram-engine/model";
import type { SnapshotSummary } from "@/features/workspace/store";
import { formatDateTime } from "@/utils/format-date";

/**
 * Snapshot history. Restoring never deletes: the restored model is saved forward as
 * a new head, so the turn you restored from is still in the list afterwards. That is
 * what makes it safe to use as an undo for a deletion.
 */
export function HistoryMenu({
  workspaceId,
  onRestore,
}: {
  workspaceId: string;
  onRestore: (restored: {
    model: InfraModel;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
  }) => void;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);

  async function load(open: boolean) {
    if (!open) return;
    setSnapshots(null);
    try {
      setSnapshots(await listSnapshotsAction(workspaceId));
    } catch {
      setSnapshots([]);
    }
  }

  async function restore(snapshotId: string) {
    const restored = await restoreSnapshotAction(workspaceId, snapshotId);
    if (!restored) {
      toast.error("Couldn’t restore that snapshot.");
      return;
    }
    onRestore(restored);
  }

  return (
    <DropdownMenu onOpenChange={load}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 font-mono text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <History className="size-3" aria-hidden /> History
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Snapshot history</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {snapshots === null && (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        )}
        {snapshots?.length === 0 && (
          <DropdownMenuItem disabled>
            No saved snapshots yet
          </DropdownMenuItem>
        )}
        {snapshots?.map((snapshot, index) => (
          <DropdownMenuItem key={snapshot.id} onSelect={() => void restore(snapshot.id)}>
            <span className="flex w-full items-center justify-between gap-3">
              <span className="font-mono text-xs">
                {index === 0 ? "Current" : formatDateTime(snapshot.createdAt)}
              </span>
              <span className="font-mono text-2xs text-muted-foreground">
                {snapshot.nodeCount} nodes
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        {snapshots && snapshots.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">
              Restoring saves forward. Nothing here is deleted.
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
