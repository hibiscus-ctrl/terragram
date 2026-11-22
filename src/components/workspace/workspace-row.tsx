// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Clock, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import { renameWorkspaceAction } from "@/features/workspace/actions";
import { formatDate, relativeTime } from "@/utils/format-date";

function initialsOf(name: string): string {
  return (
    name
      .replace(/[-_]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0))
      .join("")
      .toUpperCase() || "W"
  );
}

/**
 * The browser's clock, refreshed each minute, or null until mounted. Reading
 * `Date.now()` during render made the server and the hydrating browser disagree
 * ("just now" vs "1m ago" for a workspace half a minute old: React #418), so the
 * server render and hydration both show the absolute date and the relative time
 * replaces it once mounted.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** One saved workspace, renameable in place. */
export function WorkspaceRow({
  id,
  name,
  subtitle,
  updatedAt,
}: {
  id: string;
  name: string;
  subtitle: string;
  updatedAt: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [current, setCurrent] = useState(name);
  const now = useNow();

  async function commit() {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === current) {
      setDraft(current);
      return;
    }
    const result = await renameWorkspaceAction(id, trimmed);
    if (result.ok) {
      setCurrent(trimmed);
      toast.success("Workspace renamed");
    } else {
      setDraft(current);
      toast.error("Couldn’t rename that workspace.");
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken font-mono text-2xs font-bold text-ink-soft">
          {initialsOf(current)}
        </span>
        <input
          // biome-ignore lint/a11y/noAutofocus: the field replaces a button the user just pressed
          autoFocus
          value={draft}
          aria-label="Workspace name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setDraft(current);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <button
          type="button"
          onClick={() => void commit()}
          aria-label="Save name"
          className="rounded-md p-1.5 text-success hover:bg-surface-sunken focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <Check className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(current);
            setEditing(false);
          }}
          aria-label="Cancel rename"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-sunken focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-subtle">
      <Link href={`/workspace/canvas?id=${id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken font-mono text-2xs font-bold text-ink-soft">
          {initialsOf(current)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{current}</span>
          <span className="block font-mono text-2xs text-muted-foreground">{subtitle}</span>
        </span>
      </Link>
      <span className="flex items-center gap-1 font-mono text-2xs text-muted-foreground">
        <Clock className="size-3" aria-hidden />{" "}
        {now === null ? formatDate(updatedAt) : relativeTime(updatedAt, now)}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Rename ${current}`}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-sunken hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
