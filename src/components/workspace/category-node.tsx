// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { memo } from "react";
import { Handle, type NodeProps, Position } from "@xyflow/react";

import { CATEGORY_META } from "terragram-engine/model";
import { cn } from "@/utils/cn";
import type { CategoryNodeData } from "./graph";

/**
 * A semantic infrastructure node: white card, category-coloured border, a mono
 * category eyebrow with a colour dot, and the resource name. Flagged nodes carry
 * a warning glyph so the review gate is legible on the canvas itself.
 */
function CategoryNodeImpl({ data, selected }: NodeProps) {
  const { category, label, flagged, hidden, labelFace } = data as CategoryNodeData;
  const meta = CATEGORY_META[category];
  const borderColor = flagged ? "var(--warning)" : meta.color;

  return (
    <div
      className={cn(
        "relative flex flex-col justify-center gap-1 rounded-[9px] bg-card px-3 py-2 shadow-[0_1px_2px_rgba(46,38,24,0.05)] transition-opacity",
        hidden && "opacity-25",
        selected && "ring-2 ring-primary/40",
      )}
      style={{ width: 172, height: 62, border: `1.5px solid ${borderColor}` }}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-transparent" isConnectable={false} />
      <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: meta.color }} aria-hidden />
        <span style={{ color: meta.color }}>{meta.label}</span>
      </span>
      <span
        className={cn(
          "truncate text-[13px] font-bold text-foreground",
          labelFace === "sans" ? "font-sans" : "font-mono",
        )}
      >
        {label}
      </span>
      {flagged && (
        <span
          className="absolute -top-2 -right-2 flex size-4 items-center justify-center rounded-full bg-warning text-[10px] font-bold text-white"
          role="img"
          aria-label="Needs review"
        >
          !
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  );
}

const CategoryNode = memo(CategoryNodeImpl);

export const nodeTypes = { category: CategoryNode };
