// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { CATEGORY_META, type NodeCategory } from "terragram-engine/model";
import { cn } from "@/utils/cn";

const LEGEND_ORDER: NodeCategory[] = [
  "compute",
  "storage",
  "network",
  "identity",
  "observability",
  "edge",
];

export function Legend({
  hidden,
  onToggle,
}: {
  hidden: Set<NodeCategory>;
  onToggle: (category: NodeCategory) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-0 p-0" aria-label="Filter node categories">
      {LEGEND_ORDER.map((cat) => {
        const meta = CATEGORY_META[cat];
        const on = !hidden.has(cat);
        return (
          <label
            key={cat}
            className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-ink-soft select-none"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle(cat)}
              className="size-3.5 cursor-pointer rounded border-line-strong accent-primary"
            />
            <span
              className={cn("size-2 rounded-full transition-opacity", !on && "opacity-30")}
              style={{ backgroundColor: meta.color }}
              aria-hidden
            />
            <span className={cn(!on && "text-ink-faint line-through")}>{meta.label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
