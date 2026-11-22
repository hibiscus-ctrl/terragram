// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import Link from "next/link";
import { CheckCircle2, Copy, Download, FileCode2, Image, ShieldCheck, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { EvidenceBundle } from "@/features/workspace/evidence";
import { CATEGORY_META, type InfraModel, resourceNodes } from "@/features/workspace/model";
import type { EvidenceReceipt } from "@/features/workspace/sign";
import { formatDate, formatDateTime } from "@/utils/format-date";

function shortHash(contentHash: string): string {
  const hex = contentHash.replace(/^sha256:/, "");
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

export function EvidencePane({
  model,
  summary,
  receipt,
  stored,
  priorReceipts,
  onDownload,
  onDownloadBundle,
  onExportDiagram,
  onCopyPlan,
  openChange,
}: {
  model: InfraModel;
  summary: EvidenceBundle;
  /** The signed receipt from the review gate; null while it's still being built. */
  receipt: EvidenceReceipt | null;
  /** Whether this approval was recorded server-side, or only handed to the browser. */
  stored: boolean;
  priorReceipts: Array<{ id: string; contentHash: string; signed: boolean; approvedAt: string }>;
  onDownload: () => void;
  onDownloadBundle: () => void;
  onExportDiagram: () => void;
  onCopyPlan: () => void;
  /** The "Open pull request" control, owned by the workspace so this pane stays a view. */
  openChange?: React.ReactNode;
}) {
  const resources = resourceNodes(model);
  const inferenceMode = receipt
    ? receipt.engine === "managed"
      ? "Managed · UK Bedrock"
      : "Deterministic · local"
    : summary.inferenceMode;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line-strong px-4 py-3">
        <p className="font-mono text-2xs font-semibold tracking-[0.08em] text-primary uppercase">
          Generated
        </p>
        <h2 className="text-sm font-bold text-foreground">
          {resources.length} {resources.length === 1 ? "resource" : "resources"} ready
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-2.5">
          {receipt ? (
            <div
              className={
                receipt.signed
                  ? "flex items-start gap-2.5 rounded-xl border border-success-border bg-success-bg p-3"
                  : "flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg p-3"
              }
            >
              {receipt.signed ? (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="font-mono text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Evidence bundle
                </p>
                <p className="text-sm font-semibold text-foreground">
                  {receipt.signed ? "Signed · Ed25519" : "Content hash · unsigned"}
                </p>
                <p className="mt-0.5 font-mono text-2xs break-all text-muted-foreground">
                  {shortHash(receipt.contentHash)}
                  {receipt.signed && receipt.keyId ? ` · key ${receipt.keyId}` : ""}
                </p>
                {!receipt.signed && (
                  <p className="mt-1 text-2xs leading-relaxed text-ink-soft">
                    Set <span className="font-mono">EVIDENCE_SIGNING_KEY</span> to attach an
                    Ed25519 signature.
                  </p>
                )}
                <p className="mt-1 text-2xs leading-relaxed text-ink-soft">
                  {stored
                    ? "Recorded in this workspace's audit trail."
                    : "Not recorded server-side — download the bundle to keep it."}
                </p>
              </div>
            </div>
          ) : (
            <EvidenceCard label="Evidence bundle" value="SBOM + plan" caption={`preview #${summary.previewId}`} />
          )}

          {receipt && (
            <EvidenceCard
              label="Approved by"
              value={receipt.approver}
              caption={formatDateTime(receipt.approvedAt)}
            />
          )}

          <EvidenceCard
            label="Inference mode"
            value={inferenceMode}
            caption={receipt ? receipt.regionLabel : summary.region}
          />
        </div>

        <p className="mt-5 mb-2 font-mono text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          Resources created · {resources.length}
        </p>
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line-strong">
          {resources.map((node) => {
            const meta = CATEGORY_META[node.category];
            return (
              <li key={node.id} className="flex items-center justify-between gap-2 px-3 py-2.5">
                <span className="flex items-center gap-2 font-mono text-sm text-foreground">
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                  {node.label}
                </span>
                <span className={`font-mono text-2xs font-semibold uppercase ${meta.text}`}>
                  {meta.label}
                </span>
              </li>
            );
          })}
        </ul>

        {priorReceipts.length > 0 && (
          <>
            <p className="mt-5 mb-2 font-mono text-2xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              Earlier approvals · {priorReceipts.length}
            </p>
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line-strong">
              {priorReceipts.map((prior) => (
                <li key={prior.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0 font-mono text-2xs text-muted-foreground">
                    {shortHash(prior.contentHash)}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {formatDate(prior.approvedAt)}
                    {prior.signed ? " · signed" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-line-strong p-3">
        <Button className="w-full" onClick={onDownloadBundle}>
          <ShieldCheck className="size-4" aria-hidden /> Download evidence bundle
        </Button>
        <Button variant="outline" className="w-full" onClick={onDownload}>
          <Download className="size-4" aria-hidden /> Terraform only (.zip)
        </Button>
        {openChange}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onExportDiagram}>
            <Image className="size-4" aria-hidden /> Diagram (.svg)
          </Button>
          <Button variant="outline" onClick={onCopyPlan}>
            <Copy className="size-4" aria-hidden /> Copy plan
          </Button>
        </div>
        <p className="flex items-center justify-center gap-1.5 text-center font-mono text-2xs text-muted-foreground">
          <FileCode2 className="size-3" aria-hidden /> {summary.sbom.map((s) => `${s.name}@${s.version}`).join(" · ")}
        </p>
        <p className="text-center text-2xs text-muted-foreground">
          The bundle verifies offline at{" "}
          <Link href="/verify" className="text-primary underline underline-offset-2">
            /verify
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function EvidenceCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-success-border bg-success-bg p-3">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      <div className="min-w-0">
        <p className="font-mono text-2xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {label}
        </p>
        <p className="text-sm font-semibold text-foreground">{value}</p>
        {caption && <p className="mt-0.5 font-mono text-2xs text-muted-foreground">{caption}</p>}
      </div>
    </div>
  );
}
