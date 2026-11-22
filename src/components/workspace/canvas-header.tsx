"use client";

import { ArrowRight, PanelRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { NodeCategory } from "@/features/workspace/model";
import type { WorkspaceMode } from "@/features/workspace/modes";
import { Legend } from "./legend";
import { ModeMenu } from "./mode-menu";

export function CanvasHeader({
  mode,
  onModeChange,
  status,
  hidden,
  onToggleCategory,
  actionLabel,
  onAction,
  actionDisabled,
  paletteOpen,
  onTogglePalette,
}: {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  status: string;
  hidden: Set<NodeCategory>;
  onToggleCategory: (c: NodeCategory) => void;
  actionLabel: string;
  onAction: () => void;
  actionDisabled: boolean;
  paletteOpen: boolean;
  onTogglePalette: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line-strong bg-background px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <h2 className="text-sm font-bold text-foreground">Diagram</h2>
        <ModeMenu mode={mode} onChange={onModeChange} />
        <span className="font-mono text-xs text-muted-foreground">{status}</span>
      </div>
      <div className="flex items-center gap-4">
        <Legend hidden={hidden} onToggle={onToggleCategory} />
        <button
          type="button"
          onClick={onTogglePalette}
          aria-pressed={paletteOpen}
          className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 font-mono text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <PanelRight className="size-3" aria-hidden /> Components
        </button>
        <Button size="sm" onClick={onAction} disabled={actionDisabled}>
          {actionLabel} <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
