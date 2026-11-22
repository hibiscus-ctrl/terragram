// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState } from "react";
import { Plus, Search } from "lucide-react";

import { KIND_DEFINITIONS } from "@/features/workspace/kinds";
import { CATEGORY_META, type NodeCategory } from "@/features/workspace/model";
import { cn } from "@/utils/cn";

/**
 * The component palette. Everything here is driven by the kind registry, so a kind
 * added there appears on the canvas with no further wiring.
 *
 * Both routes in are keyboard-reachable: drag a card, or focus it and press Enter.
 * The diagram is the product's main surface, so "you can build one without a mouse"
 * has to be literally true, not a stated aspiration.
 */

type PaletteEntry = { kind: string; label: string; category: NodeCategory };

const ENTRIES: PaletteEntry[] = KIND_DEFINITIONS.filter(
  (def) => def.role !== "conceptual" && def.role !== "external",
).map((def) => ({ kind: def.kind, label: def.label, category: def.category }));

const GROUP_ORDER: NodeCategory[] = [
  "compute",
  "network",
  "storage",
  "identity",
  "observability",
];

export function Palette({ onAdd }: { onAdd: (kind: string) => void }) {
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? ENTRIES.filter(
        (e) => e.label.toLowerCase().includes(needle) || e.kind.includes(needle),
      )
    : ENTRIES;

  return (
    <div className="flex h-full flex-col border-l border-line-strong bg-card">
      <div className="border-b border-line-strong px-3 py-2.5">
        <h2 className="text-sm font-bold text-foreground">Components</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Drag onto the canvas, or press Enter to add.
        </p>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter components"
            aria-label="Filter components"
            className="w-full rounded-lg border border-line-strong bg-background py-1.5 pr-2 pl-7 text-xs text-foreground placeholder:text-ink-faint focus-visible:ring-3 focus-visible:ring-primary/30 focus-visible:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {matches.length === 0 && (
          <p className="text-xs text-muted-foreground">No component matches “{query}”.</p>
        )}
        {GROUP_ORDER.map((category) => {
          const group = matches.filter((e) => e.category === category);
          if (group.length === 0) return null;
          const meta = CATEGORY_META[category];
          return (
            <section key={category} className="mb-4 last:mb-0">
              <h3 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.06em] uppercase">
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: meta.color }}
                  aria-hidden
                />
                <span style={{ color: meta.color }}>{meta.label}</span>
              </h3>
              <ul className="flex flex-col gap-1">
                {group.map((entry) => (
                  <li key={entry.kind}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/terragram-kind", entry.kind);
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => onAdd(entry.kind)}
                      className={cn(
                        "group flex w-full cursor-grab items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-xs font-semibold text-foreground",
                        "hover:border-line-strong hover:bg-background",
                        "focus-visible:ring-3 focus-visible:ring-primary/30 focus-visible:outline-none",
                      )}
                    >
                      <span className="truncate">{entry.label}</span>
                      <Plus
                        className="size-3.5 shrink-0 text-ink-faint group-hover:text-primary"
                        aria-hidden
                      />
                      <span className="sr-only">Add {entry.label} to the diagram</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
