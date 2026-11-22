// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useRef, useState } from "react";
import { CheckCircle2, HelpCircle, Upload, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BundleEntry } from "@/features/workspace/receipt";
import { readBundleZip, type VerifyReport, type VerifyStatus, verifyBundle } from "@/features/workspace/verify";
import { cn } from "@/utils/cn";
import { formatDateTime } from "@/utils/format-date";

/**
 * The offline verifier.
 *
 * Every computation happens here in the browser. The page deliberately reports three
 * outcomes rather than two: a check can pass, fail, or be impossible to make — and
 * saying "I could not check this" is the honest answer when someone brings a receipt
 * without its bundle, or a browser without Ed25519.
 */

function StatusIcon({ status }: { status: VerifyStatus }) {
  if (status === "pass") return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />;
  if (status === "fail") return <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />;
  return <HelpCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />;
}

const STATUS_STYLE: Record<VerifyStatus, string> = {
  pass: "border-success-border bg-success-bg",
  fail: "border-destructive/30 bg-destructive/5",
  unavailable: "border-warning-border bg-warning-bg",
};

const STATUS_WORD: Record<VerifyStatus, string> = {
  pass: "Verified",
  fail: "Failed",
  unavailable: "Not checked",
};

function Row({ title, status, detail }: { title: string; status: VerifyStatus; detail: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl border p-3.5", STATUS_STYLE[status])}>
      <StatusIcon status={status} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">
          {title} · {STATUS_WORD[status]}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">{detail}</p>
      </div>
    </div>
  );
}

export function VerifyClient() {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function check(entries: BundleEntry[]) {
    setError(null);
    try {
      setReport(await verifyBundle(entries));
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "That bundle could not be read.");
    }
  }

  async function handleFile(file: File) {
    setError(null);
    try {
      if (file.name.endsWith(".zip")) {
        await check(await readBundleZip(file));
        return;
      }
      await check([{ name: file.name, content: await file.text() }]);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "That file could not be read.");
    }
  }

  return (
    <div className="mt-8">
      {/* A drop target has no semantic element of its own, so it is a labelled
          section; the keyboard route is the button inside it. */}
      <section
        aria-label="Evidence bundle drop area"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={cn(
          "flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-primary bg-accent" : "border-line-strong bg-surface-subtle",
        )}
      >
        <Upload className="size-6 text-ink-faint" aria-hidden />
        <p className="text-sm font-semibold text-foreground">
          Drop <span className="font-mono">terragram-evidence.zip</span> here
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Or a single <span className="font-mono">receipt.json</span>, which confirms the
          signature but cannot confirm the contents.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          className="sr-only"
          aria-label="Choose an evidence bundle"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          Choose a file
        </Button>
      </section>

      <details className="mt-4 rounded-xl border border-line-strong px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Paste a receipt instead
        </summary>
        <label htmlFor="verify-paste" className="sr-only">
          Receipt JSON
        </label>
        <textarea
          id="verify-paste"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder='{ "schema": "terragram.receipt/v1", ... }'
          className="mt-3 min-h-32 w-full resize-none rounded-xl border border-line-strong bg-surface-code p-3 font-mono text-xs text-foreground outline-none focus:border-input"
        />
        <Button
          size="sm"
          className="mt-2"
          disabled={!pasted.trim()}
          onClick={() => void check([{ name: "receipt.json", content: pasted }])}
        >
          Check receipt
        </Button>
      </details>

      {error && (
        <p className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5 text-sm text-foreground">
          {error}
        </p>
      )}

      {report && (
        <section className="mt-8" aria-live="polite">
          <h2 className="text-lg font-bold text-foreground">
            {report.ok ? "This bundle is intact" : "This bundle did not fully verify"}
          </h2>

          <div className="mt-4 flex flex-col gap-3">
            <Row title="Content hash" status={report.hash.status} detail={report.hash.detail} />
            <Row title="Signature" status={report.signature.status} detail={report.signature.detail} />
          </div>

          {report.receipt && (
            <dl className="mt-6 divide-y divide-line rounded-xl border border-line-strong">
              <Detail label="Approved by" value={report.receipt.approver} />
              <Detail
                label="Approved at"
                value={formatDateTime(report.receipt.approvedAt)}
              />
              <Detail
                label="Target"
                value={`${report.receipt.cloud === "aws" ? "AWS" : "Azure"} · ${report.receipt.regionLabel}`}
              />
              <Detail
                label="Translator"
                value={report.receipt.engine === "managed" ? "Managed · UK Bedrock" : "Deterministic · local"}
              />
              <Detail label="Resources" value={String(report.receipt.resourceCount)} />
              <Detail label="Content hash" value={report.receipt.contentHash} mono />
              {report.receipt.provenance && (
                <>
                  {/* Naming the engine is not enough to say who produced a plan:
                      the model that chose the components and the runtime that ran
                      the emitter are part of the acting chain too. The scanner row
                      exists so that "nothing was scanned here" is stated rather
                      than left to be assumed. */}
                  <Detail
                    label="Model"
                    value={report.receipt.provenance.model ?? "None — the deterministic engine chose the components"}
                  />
                  <Detail label="Runtime" value={report.receipt.provenance.node} />
                  <Detail
                    label="Scanners at generation"
                    value={
                      report.receipt.provenance.scanners.length === 0
                        ? "None — the plan is checked before release and in your own pipeline, not here"
                        : report.receipt.provenance.scanners
                            .map((s) => `${s.tool} ${s.version ?? "(version not recorded)"}`)
                            .join(", ")
                    }
                  />
                </>
              )}
            </dl>
          )}

          {report.receipt?.explanation && (
            <>
              <h3 className="mt-8 text-sm font-bold text-foreground">
                What the approver was shown
              </h3>
              <div className="mt-2 rounded-xl border border-line-strong bg-card p-4">
                {report.receipt.explanation.split("\n\n").map((paragraph) => (
                  <p
                    key={paragraph.slice(0, 48)}
                    className="mt-2 text-sm leading-relaxed text-ink-soft first:mt-0"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-sm break-all text-foreground", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </div>
  );
}
