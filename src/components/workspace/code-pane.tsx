// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { Fragment } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import type { TerraformFile } from "@/features/workspace/terraform";
import { cn } from "@/utils/cn";

const KEYWORDS = new Set([
  "resource",
  "provider",
  "terraform",
  "required_providers",
  "variable",
  "output",
  "module",
  "data",
  "features",
  "jsonencode",
  "sensitive",
  "true",
  "false",
]);

const TOKEN_RE = /(#[^\n]*)|("(?:[^"\\]|\\.)*")|(\b\d+\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

/** Lightweight, dependency-free HCL tokeniser for the light code surface. */
function highlight(line: string) {
  const out: { text: string; cls: string }[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  while (true) {
    const m = TOKEN_RE.exec(line);
    if (m === null) break;
    if (m.index > last) out.push({ text: line.slice(last, m.index), cls: "" });
    if (m[1]) out.push({ text: m[1], cls: "text-ink-faint italic" });
    else if (m[2]) out.push({ text: m[2], cls: "text-cat-compute" });
    else if (m[3]) out.push({ text: m[3], cls: "text-cat-security" });
    else if (m[4]) out.push({ text: m[4], cls: KEYWORDS.has(m[4]) ? "text-cat-storage font-semibold" : "" });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), cls: "" });
  return out;
}

/** The plain-English tab sits alongside the files, because for a good number of
 *  reviewers it is the only one of these tabs they can actually read. */
const EXPLAIN_TAB = "Explain";

export function CodePane({
  files,
  activeFile,
  onSelectFile,
  provider,
  explanation,
}: {
  files: TerraformFile[];
  activeFile: string;
  onSelectFile: (name: string) => void;
  provider: string;
  explanation: string;
}) {
  const showingExplain = activeFile === EXPLAIN_TAB;
  const file = files.find((f) => f.name === activeFile) ?? files[0];
  if (!file) return null;
  const activeName = showingExplain ? EXPLAIN_TAB : file.name;
  const activeContent = showingExplain ? explanation : file.content;
  const lines = activeContent.replace(/\n$/, "").split("\n");

  async function copyActive() {
    try {
      await navigator.clipboard.writeText(activeContent);
      toast.success(`Copied ${activeName}`);
    } catch {
      toast.error("Couldn’t copy — your browser blocked clipboard access.");
    }
  }

  const tabs = [...files.map((f) => f.name), EXPLAIN_TAB];

  return (
    <div className="flex h-full min-w-0 flex-col bg-card">
      <div className="flex shrink-0 items-center justify-between border-b border-line-strong pr-4">
        <div className="flex" role="tablist" aria-label="Generated plan">
          {tabs.map((name) => {
            const f = { name };
            const active = showingExplain ? name === EXPLAIN_TAB : name === file.name;
            return (
              <button
                key={f.name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectFile(f.name)}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 px-4 py-2.5 font-mono text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
                  active
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {active && <span className="size-1.5 rounded-full bg-cat-storage" aria-hidden />}
                {f.name}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={copyActive}
            className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 font-mono text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <Copy className="size-3" aria-hidden /> Copy
          </button>
          <span className="hidden font-mono text-2xs text-muted-foreground sm:inline">{provider}</span>
        </div>
      </div>

      {showingExplain ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          <div className="max-w-prose">
            {activeContent.split("\n\n").map((paragraph) => (
              <p
                key={paragraph.slice(0, 48)}
                className="mt-3 text-sm leading-relaxed text-ink-soft first:mt-0"
              >
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="min-w-max p-0 font-mono text-xs leading-[1.6]">
          <code className="grid grid-cols-[auto_1fr]">
            {lines.map((line, i) => (
              <Fragment key={i}>
                <span className="select-none border-r border-line px-3 text-right text-ink-faint">
                  {i + 1}
                </span>
                <span className="px-4 whitespace-pre text-foreground">
                  {highlight(line).map((tok, j) => (
                    <span key={j} className={tok.cls}>
                      {tok.text}
                    </span>
                  ))}
                </span>
              </Fragment>
            ))}
          </code>
        </pre>
      </div>
      )}
    </div>
  );
}
