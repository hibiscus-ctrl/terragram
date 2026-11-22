// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Feasibility } from "terragram-engine/feasibility";
import type { Cloud, InfraModel } from "terragram-engine/model";
import { CATEGORY_META, countFlags } from "terragram-engine/model";
import { CLOUD_LABEL } from "terragram-engine/modes";
import { cn } from "@/utils/cn";

export function ReviewPane({
  model,
  cloud,
  onCloudChange,
  regionLabel,
  explanation,
  feasibility,
  onBack,
  onGenerate,
}: {
  model: InfraModel;
  cloud: Cloud;
  onCloudChange: (c: Cloud) => void;
  regionLabel: string;
  /** The plain-English description the approver is signing for. */
  explanation: string;
  /** What generation will and will not build, from the model alone. */
  feasibility: Feasibility;
  onBack: () => void;
  onGenerate: () => void;
}) {
  const flagged = model.nodes.filter((n) => n.flag);
  const flags = countFlags(model);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line-strong px-4 py-3">
        <h1 className="text-sm font-bold text-foreground">Review gate</h1>
        <p className="text-xs text-muted-foreground">Confirm the model before generating code</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {flags > 0 ? (
          <div className="rounded-xl border border-warning-border bg-warning-bg p-3.5">
            <p className="text-sm font-semibold text-warning">
              {flags} {flags === 1 ? "node needs" : "nodes need"} review
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              The model flagged low-confidence attributes. Confirm them before generating, or
              generate anyway and edit the plan.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-success-border bg-success-bg p-3.5">
            <p className="text-sm font-semibold text-success">Nothing flagged</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              Every attribute resolved confidently. You&rsquo;re clear to generate.
            </p>
          </div>
        )}

        {feasibility.omitted.length > 0 && (
          <div className="mt-3 rounded-xl border border-danger-border bg-danger-bg p-3.5">
            <p className="text-sm font-semibold text-danger">
              {feasibility.omitted.length} {feasibility.omitted.length === 1 ? "component" : "components"} will not be generated
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              {feasibility.summary} The receipt records what was left out.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {feasibility.components
                .filter((c) => c.status === "unsupported")
                .map((c) => (
                  <li key={c.id} className="text-xs text-ink-soft">
                    <span className="font-semibold text-foreground">{c.label}</span>
                    {c.suggestion ? ` — could be ${c.suggestion}` : " — no matching kind"}
                  </li>
                ))}
            </ul>
          </div>
        )}

        <p className="mt-5 mb-2 font-mono text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          What you are approving
        </p>
        <div className="rounded-xl border border-line-strong bg-card p-3.5">
          {explanation.split("\n\n").map((paragraph) => (
            <p key={paragraph.slice(0, 48)} className="mt-2 text-xs leading-relaxed text-ink-soft first:mt-0">
              {paragraph}
            </p>
          ))}
        </div>

        <p className="mt-5 mb-2 font-mono text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          Target cloud
        </p>
        <fieldset className="m-0 flex rounded-lg border border-line-strong p-0.5" aria-label="Target cloud">
          {(["azure", "aws"] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onCloudChange(c)}
              aria-pressed={cloud === c}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
                cloud === c ? "bg-card text-foreground shadow-sm" : "text-ink-soft hover:text-foreground",
              )}
            >
              {CLOUD_LABEL[c]}
            </button>
          ))}
        </fieldset>
        <p className="mt-2 font-mono text-xs text-muted-foreground">region · {regionLabel}</p>

        {flagged.length > 0 && (
          <>
            <p className="mt-5 mb-2 font-mono text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              Needs review
            </p>
            <ul className="flex flex-col gap-2.5">
              {flagged.map((node) => (
                <li
                  key={node.id}
                  className="rounded-xl border border-warning-border bg-card p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-sm font-semibold text-foreground">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: CATEGORY_META[node.category].color }}
                        aria-hidden
                      />
                      {node.label}
                    </span>
                    <span className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 font-mono text-2xs font-semibold text-warning">
                      REVIEW
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{node.flag?.reason}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="flex shrink-0 gap-2 border-t border-line-strong p-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button className="flex-1" onClick={onGenerate}>
          {flags > 0 ? "Generate anyway" : "Confirm & generate"}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
