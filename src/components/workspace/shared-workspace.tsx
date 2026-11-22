// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Eye, ShieldCheck } from "lucide-react";

import { LogoMark } from "@/components/logo";
import type { InfraModel, NodeCategory } from "@/features/workspace/model";
import { DEFAULT_SETTINGS } from "@/features/workspace/settings";
import type { TerraformFile } from "@/features/workspace/terraform";
import { formatDate } from "@/utils/format-date";
import { CodePane } from "./code-pane";
import { Legend } from "./legend";

const Canvas = dynamic(() => import("./canvas").then((m) => m.Canvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <p className="font-mono text-xs text-ink-faint">Loading canvas…</p>
    </div>
  ),
});

type SharedReceipt = {
  id: string;
  contentHash: string;
  signed: boolean;
  approver: string;
  approvedAt: string;
};

/**
 * The reviewer's view of a shared workspace: the diagram, the plan, the plain-English
 * description and the approval history — and nothing that can change any of them.
 *
 * Read-only here is structural, not cosmetic. This component is handed a model and
 * some files; it has no server actions and no mutation path to reach for, so the
 * worst a link can do is show someone the work.
 */
export function SharedWorkspace({
  name,
  subtitle,
  model,
  files,
  explanation,
  receipts,
}: {
  name: string;
  subtitle: string;
  model: InfraModel;
  files: TerraformFile[];
  explanation: string;
  receipts: SharedReceipt[];
}) {
  const [hidden, setHidden] = useState<Set<NodeCategory>>(new Set());
  const [activeFile, setActiveFile] = useState("Explain");

  function toggleCategory(c: NodeCategory) {
    setHidden((prev) => {
      const set = new Set(prev);
      if (set.has(c)) set.delete(c);
      else set.add(c);
      return set;
    });
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line-strong bg-background px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="flex items-center gap-2" aria-label="Terragram">
            <LogoMark />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-foreground">{name}</p>
            <p className="truncate font-mono text-2xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-card px-2.5 py-1 text-xs font-medium text-ink-soft">
          <Eye className="size-3.5" aria-hidden /> Read-only review link
        </span>
      </header>

      <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
        <div className="flex min-w-0 flex-1 flex-col border-r border-line-strong">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-strong px-4 py-2.5">
            <h2 className="text-sm font-bold text-foreground">Diagram</h2>
            <Legend hidden={hidden} onToggle={toggleCategory} />
          </div>
          <div className="relative min-h-0 flex-1 bg-background">
            <Canvas
              model={model}
              hiddenCategories={hidden}
              settings={DEFAULT_SETTINGS}
              readOnly
            />
          </div>
        </div>

        <div className="flex w-[520px] shrink-0 flex-col">
          <div className="min-h-0 flex-1">
            <CodePane
              files={files}
              activeFile={activeFile}
              onSelectFile={setActiveFile}
              provider={files.length > 0 ? "plan" : ""}
              explanation={explanation}
            />
          </div>
          <div className="shrink-0 border-t border-line-strong p-3">
            <p className="mb-2 font-mono text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              Approvals · {receipts.length}
            </p>
            {receipts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing has been approved in this workspace yet.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-xl border border-line-strong">
                {receipts.map((receipt) => (
                  <li key={receipt.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ShieldCheck
                        className={receipt.signed ? "size-3.5 text-success" : "size-3.5 text-warning"}
                        aria-hidden
                      />
                      <span className="truncate text-xs text-foreground">{receipt.approver}</span>
                    </span>
                    <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                      {formatDate(receipt.approvedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-2xs text-muted-foreground">
              Ask the owner for the evidence bundle to check an approval yourself at{" "}
              <Link href="/verify" className="text-primary underline underline-offset-2">
                /verify
              </Link>
              .
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
