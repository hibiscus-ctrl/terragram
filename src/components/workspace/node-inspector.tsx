// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  attributeValue,
  fieldsForKind,
  type NodeField,
} from "terragram-engine/inspector";
import { CATEGORY_META, type ModelNode } from "terragram-engine/model";

/**
 * The node inspector — click a node on the canvas to edit its confirmed attributes
 * and clear its review flag. This is what makes the review gate real: a flagged node
 * asks for the missing attribute, you choose it, "Mark resolved" clears the flag, and
 * the generated Terraform reflects the choice.
 */
export function NodeInspector({
  node,
  onClose,
  onLabelChange,
  onAttributeChange,
  onResolve,
  onDelete,
}: {
  node: ModelNode;
  onClose: () => void;
  onLabelChange: (id: string, label: string) => void;
  onAttributeChange: (id: string, key: string, value: string) => void;
  onResolve: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const meta = CATEGORY_META[node.category];
  const fields = fieldsForKind(node.kind);
  const [label, setLabel] = useState(node.label);

  // Re-sync the local label draft when the selected node's label changes.
  useEffect(() => setLabel(node.label), [node.label]);

  function commitLabel() {
    const trimmed = label.trim();
    if (trimmed && trimmed !== node.label) onLabelChange(node.id, trimmed);
    else setLabel(node.label);
  }

  return (
    <div className="flex h-full flex-col border-l border-line-strong bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-strong px-4 py-3">
        <span className="size-2 rounded-full" style={{ backgroundColor: meta.color }} aria-hidden />
        <span className="flex-1 text-sm font-semibold text-foreground">Node inspector</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <p
          className="mb-4 font-mono text-2xs font-semibold uppercase tracking-[0.06em]"
          style={{ color: meta.color }}
        >
          {meta.label}
        </p>

        {node.flag && (
          <div className="mb-4 rounded-lg border border-warning-border bg-warning-bg p-3">
            <p className="text-xs font-semibold text-warning">Needs review</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">{node.flag.reason}</p>
          </div>
        )}

        <label className="mb-1.5 block text-xs font-semibold text-muted-foreground" htmlFor="ni-service">
          Service
        </label>
        <input
          id="ni-service"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="mb-4 w-full rounded-lg border border-line-strong bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />

        {fields.map((field: NodeField) => (
          <div key={field.key}>
            <label
              className="mb-1.5 block text-xs font-semibold text-muted-foreground"
              htmlFor={`ni-${field.key}`}
            >
              {field.key}
            </label>
            {field.options ? (
              <select
                id={`ni-${field.key}`}
                value={attributeValue(node, field)}
                onChange={(e) => onAttributeChange(node.id, field.key, e.target.value)}
                className="mb-4 w-full rounded-lg border border-line-strong bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {field.options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`ni-${field.key}`}
                value={attributeValue(node, field)}
                onChange={(e) => onAttributeChange(node.id, field.key, e.target.value)}
                className="mb-4 w-full rounded-lg border border-line-strong bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 space-y-2 border-t border-line-strong p-3">
        {node.flag && (
          <Button className="w-full" onClick={() => onResolve(node.id)}>
            <CheckCircle2 className="size-4" aria-hidden /> Mark resolved
          </Button>
        )}
        {/* Removal lives here as well as on the Delete key, so building and
            unbuilding a diagram are both possible without a pointer. */}
        <Button variant="outline" className="w-full" onClick={() => onDelete(node.id)}>
          <Trash2 className="size-4" aria-hidden /> Remove from diagram
        </Button>
      </div>
    </div>
  );
}
