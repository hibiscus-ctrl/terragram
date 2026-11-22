// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import Link from "next/link";
import { Check, ChevronDown, ExternalLink, LogOut, Settings } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Cloud } from "terragram-engine/model";
import { CLOUD_LABEL } from "terragram-engine/modes";
import type { TerraformTool } from "terragram-engine/terraform";
import { cn } from "@/utils/cn";
import { LogoMark } from "@/components/logo";
import type { DemoState, WorkspaceStep } from "./types";

const STEPS: { key: WorkspaceStep; label: string }[] = [
  { key: "input", label: "Compose" },
  { key: "review", label: "Review" },
  { key: "result", label: "Evidence" },
];

const DEMO_STATES: { key: DemoState; label: string }[] = [
  { key: "ambiguous", label: "Ambiguous prompt" },
  { key: "unparseable", label: "Unreadable Terraform" },
  { key: "timeout", label: "Generation timeout" },
];

function CloudToggle({ cloud, onChange }: { cloud: Cloud; onChange: (c: Cloud) => void }) {
  return (
    <fieldset
      className="m-0 flex items-center rounded-lg border border-line-strong bg-card p-0.5"
      aria-label="Target cloud"
    >
      {(["azure", "aws"] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-pressed={cloud === c}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
            cloud === c ? "bg-foreground text-background" : "text-ink-soft hover:text-foreground",
          )}
        >
          {CLOUD_LABEL[c]}
        </button>
      ))}
    </fieldset>
  );
}

function StepIndicator({ step }: { step: WorkspaceStep }) {
  const activeIndex = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="hidden items-center gap-1.5 md:flex" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full text-2xs font-bold transition-colors",
                done && "bg-foreground text-background",
                active && "bg-foreground text-background",
                !done && !active && "bg-surface-sunken text-ink-faint",
              )}
              aria-current={active ? "step" : undefined}
              title={s.label}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            {i < STEPS.length - 1 && <span className="h-px w-6 bg-line-strong" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/** Terraform or OpenTofu. The emitted HCL is identical; what changes is what the
 *  workspace, the download and the receipt call it — so the choice is honoured
 *  rather than displayed. */
function ToolToggle({
  tool,
  onChange,
}: {
  tool: TerraformTool;
  onChange: (t: TerraformTool) => void;
}) {
  return (
    <fieldset
      className="m-0 hidden items-center rounded-lg border border-line-strong bg-card p-0.5 lg:flex"
      aria-label="Generator"
    >
      {(["terraform", "opentofu"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          aria-pressed={tool === t}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
            tool === t ? "bg-foreground text-background" : "text-ink-soft hover:text-foreground",
          )}
        >
          {t === "terraform" ? "Terraform" : "OpenTofu"}
        </button>
      ))}
    </fieldset>
  );
}

export function WorkspaceTopbar({
  region,
  inferenceMode,
  cloud,
  onCloudChange,
  tool,
  onToolChange,
  step,
  showSteps,
  user,
  onDemoState,
  onSignOut,
  extras,
}: {
  region: string;
  /** Honest label of the translator that answered ("Managed · UK Bedrock" or
   *  "Deterministic · local") — never claims managed when the stub ran. */
  inferenceMode: string;
  cloud: Cloud;
  onCloudChange: (c: Cloud) => void;
  tool: TerraformTool;
  onToolChange: (t: TerraformTool) => void;
  step: WorkspaceStep;
  showSteps: boolean;
  user: { name: string; initials: string };
  onDemoState: (kind: DemoState) => void;
  onSignOut: () => void;
  /** History and share controls, present only for a persisted workspace. */
  extras?: React.ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line-strong bg-background px-4">
      <div className="flex items-center gap-4">
        <Link href="/workspace" aria-label="New workspace" className="flex items-center gap-2">
          <LogoMark />
          <span className="hidden text-sm font-bold text-foreground sm:inline">Terragram</span>
          <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
            IaC
          </span>
        </Link>
        {showSteps && <StepIndicator step={step} />}
      </div>

      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-1.5 rounded-full border border-line-strong bg-card px-2.5 py-1 text-xs font-medium text-ink-soft lg:inline-flex">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          {region}
        </span>
        <span className="hidden rounded-full border border-line-strong bg-card px-2.5 py-1 text-xs font-medium text-ink-soft md:inline">
          {inferenceMode}
        </span>
        <CloudToggle cloud={cloud} onChange={onCloudChange} />
        <ToolToggle tool={tool} onChange={onToolChange} />
        {extras}

        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-card px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none">
            Demo states <ChevronDown className="size-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Simulate a state</DropdownMenuLabel>
            {DEMO_STATES.map((d) => (
              <DropdownMenuItem key={d.key} onSelect={() => onDemoState(d.key)}>
                {d.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg border border-line-strong bg-card px-2 py-1 transition-colors hover:bg-surface-sunken focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none">
            <span className="hidden text-xs font-semibold text-ink-soft sm:inline">{user.name}</span>
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-2xs font-bold text-primary-foreground">
              {user.initials}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{user.name}</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings className="size-4" aria-hidden /> Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/">
                <ExternalLink className="size-4" aria-hidden /> Back to site
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOut className="size-4" aria-hidden /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
