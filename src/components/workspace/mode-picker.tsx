// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { LogoMark } from "@/components/logo";
import { createWorkspaceAction } from "@/features/workspace/actions";
import { FORMAT_CHIP, formatLabel, MODE_LIST, MODE_META } from "@/features/workspace/modes";
import type { WorkspaceSummary } from "@/features/workspace/store";
import { WORKSPACE_TEMPLATES } from "@/features/workspace/templates";
import { WorkspaceRow } from "./workspace-row";

function ModeCard({ mode }: { mode: (typeof MODE_LIST)[number] }) {
  return (
    <form action={createWorkspaceAction}>
      <input type="hidden" name="mode" value={mode.id} />
      <button
        type="submit"
        className="group flex w-full flex-col gap-3 rounded-2xl border border-line-strong bg-card p-5 text-left transition-colors hover:border-input hover:bg-surface-subtle focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <span className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 font-mono text-xs font-semibold ${FORMAT_CHIP[mode.from]}`}>
            {formatLabel(mode.from)}
          </span>
          <ArrowRight className="size-3.5 text-ink-faint" aria-hidden />
          <span className={`rounded-md px-2 py-0.5 font-mono text-xs font-semibold ${FORMAT_CHIP[mode.to]}`}>
            {formatLabel(mode.to)}
          </span>
        </span>
        <span>
          <span className="block text-base font-bold text-foreground">{mode.title}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{mode.body}</span>
        </span>
      </button>
    </form>
  );
}

export function ModePicker({
  user,
  workspaces = [],
}: {
  user: { name: string; initials: string };
  workspaces?: WorkspaceSummary[];
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between border-b border-line-strong px-4">
        <Link href="/workspace" className="flex items-center gap-2" aria-label="Terragram workspaces">
          <LogoMark />
          <span className="text-sm font-bold text-foreground">Terragram</span>
          <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
            IaC
          </span>
        </Link>
        <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-card px-2 py-1">
          <span className="hidden text-xs font-semibold text-ink-soft sm:inline">{user.name}</span>
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-2xs font-bold text-primary-foreground">
            {user.initials}
          </span>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 outline-none">
        <p className="font-mono text-2xs font-semibold tracking-[0.08em] text-cat-storage uppercase">
          New workspace
        </p>
        <h1 className="mt-2 text-[clamp(26px,4vw,34px)] leading-[1.1] font-extrabold tracking-[-0.02em] text-foreground">
          What do you want to translate?
        </h1>
        <p className="mt-3 max-w-xl text-base leading-[1.5] text-muted-foreground">
          Pick a direction. Terragram moves between plain English, diagrams and Terraform through one
          auditable model. You can switch modes any time.
        </p>

        <ol className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <li>
            <span className="font-mono font-semibold text-foreground">1.</span> Describe or paste
          </li>
          <li>
            <span className="font-mono font-semibold text-foreground">2.</span> Review the gate
          </li>
          <li>
            <span className="font-mono font-semibold text-foreground">3.</span> Generate signed evidence
          </li>
        </ol>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {MODE_LIST.map((mode) => (
            <ModeCard key={mode.id} mode={mode} />
          ))}
        </div>

        <div className="mt-10">
          <p className="mb-3 font-mono text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Start from a template
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {WORKSPACE_TEMPLATES.map((template) => (
              <form key={template.id} action={createWorkspaceAction}>
                <input type="hidden" name="mode" value="diagram-terraform" />
                <input type="hidden" name="template" value={template.id} />
                <button
                  type="submit"
                  className="w-full rounded-xl border border-line-strong bg-card p-4 text-left transition-colors hover:border-input hover:bg-surface-subtle focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <span className="block text-sm font-bold text-foreground">{template.name}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {template.summary}
                  </span>
                </button>
              </form>
            ))}
          </div>
        </div>

        <div className="mt-10">
          <p className="mb-3 font-mono text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Your workspaces
          </p>
          {workspaces.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted-foreground">
              No workspaces yet. Pick a direction above to create your first.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line-strong">
              {workspaces.map((ws) => (
                <li key={ws.id}>
                  <WorkspaceRow
                    id={ws.id}
                    name={ws.name}
                    subtitle={`${MODE_META[ws.mode].title} · ${ws.cloud} · ${ws.tool}`}
                    updatedAt={ws.updatedAt}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
