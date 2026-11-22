"use client";

import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MODE_LIST,
  modeArrowLabel,
  type WorkspaceMode,
} from "@/features/workspace/modes";
import { cn } from "@/utils/cn";

export function ModeMenu({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-lg bg-surface-sunken px-2.5 py-1.5 font-mono text-xs font-semibold text-primary transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none">
        {modeArrowLabel(mode)}
        <ChevronDown className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Switch mode</DropdownMenuLabel>
        {MODE_LIST.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onChange(m.id)}
            className={cn("font-mono text-xs", m.id === mode && "text-primary")}
          >
            <span className="flex-1">{modeArrowLabel(m.id)}</span>
            {m.id === mode && <Check className="size-3.5" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
