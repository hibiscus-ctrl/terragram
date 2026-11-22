// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useRef, useState } from "react";
import { FileUp, ImageUp, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/cn";
import type { WorkspaceMode } from "@/features/workspace/modes";
import {
  SAMPLE_MERMAID,
  SAMPLE_TERRAFORM,
  SAMPLE_TERRAFORM_PARTIAL,
} from "@/features/workspace/samples";
import { WORKSPACE_TEMPLATES } from "@/features/workspace/templates";
import { PaneHeader } from "./compose-pane";

/**
 * Left pane for the reverse modes.
 *
 * Terraform → Diagram takes pasted or uploaded HCL and reads it properly. Diagram →
 * Terraform starts from a picture of a diagram — a screenshot or a photo of a
 * whiteboard, read by managed inference — or from a Mermaid flowchart, pasted or
 * opened from a file, or from a template. Only formats the importer can actually
 * read are offered; there is no .drawio option because there is no .drawio reader.
 */
/**
 * The picture formats the reader accepts, as both the file dialog's filter and the
 * guard for a dropped file — a drop bypasses `accept`, so the two must be one list.
 * Mirrors `IMAGE_MEDIA_TYPES` on the server, which has the final say.
 */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function ParsePane({
  mode,
  onModeChange,
  from,
  onParse,
  onImage,
  onStartTemplate,
  imageBusy = false,
}: {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  from: "terraform" | "diagram";
  onParse: (source: string) => void;
  /** A picture of a diagram to read through managed inference. */
  onImage?: (file: File) => void;
  onStartTemplate?: (templateId: string) => void;
  imageBusy?: boolean;
}) {
  const [value, setValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  function handleImageFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onImage?.(file);
    event.target.value = "";
  }

  // A dashed box is the universal "drop here" affordance, so it has to accept a
  // drop: without these handlers the browser treats the drop as a navigation and
  // opens the image, discarding the workspace.
  function handleImageDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (imageBusy) return;
    const file = event.dataTransfer.files?.[0];
    if (file) onImage?.(file);
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setValue(await file.text());
    event.target.value = "";
  }

  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        title={from === "terraform" ? "Paste Terraform" : "Import a diagram"}
        subtitle={
          from === "terraform"
            ? "Reverse-engineer HCL into the model"
            : "A screenshot, a Mermaid flowchart, or a template"
        }
        mode={mode}
        onModeChange={onModeChange}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {from === "terraform" ? (
          <>
            <label htmlFor="parse-input" className="sr-only">
              Terraform source
            </label>
            <textarea
              id="parse-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={'resource "azurerm_service_plan" "web" {\n  ...\n}'}
              className="min-h-56 flex-1 resize-none rounded-xl border border-line-strong bg-surface-code p-3.5 font-mono text-xs text-foreground outline-none focus:border-input"
            />
            <input
              ref={fileRef}
              type="file"
              accept=".tf,.tofu,.hcl,text/plain"
              onChange={handleFile}
              className="sr-only"
              aria-label="Open a Terraform file"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setValue(SAMPLE_TERRAFORM)}
                  className="rounded font-mono text-xs text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  Load sample
                </button>
                <button
                  type="button"
                  onClick={() => setValue(SAMPLE_TERRAFORM_PARTIAL)}
                  className="rounded font-mono text-xs text-muted-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  Partly translatable
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded font-mono text-xs text-muted-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <Upload className="size-3" aria-hidden /> Open .tf file
                </button>
              </div>
              <Button size="sm" onClick={() => onParse(value)} disabled={!value.trim()}>
                <FileUp className="size-4" aria-hidden /> Parse Terraform
              </Button>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Terragram reads resources, their attributes and the references between them.
              Modules and data sources it cannot translate are kept on the diagram and flagged,
              never silently dropped.
            </p>
          </>
        ) : (
          <>
            <input
              ref={imageRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              onChange={handleImageFile}
              className="sr-only"
              aria-label="Open a picture of a diagram"
            />
            <button
              type="button"
              onClick={() => imageRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleImageDrop}
              disabled={imageBusy}
              aria-busy={imageBusy}
              className={cn(
                "flex w-full flex-col items-center gap-2 rounded-xl border border-dashed p-5 text-center transition-colors hover:border-input hover:bg-surface-subtle focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-60",
                dragging ? "border-primary bg-accent" : "border-line-strong bg-card",
              )}
            >
              <ImageUp className="size-6 text-primary" aria-hidden />
              <span className="text-sm font-semibold text-foreground">
                {imageBusy ? "Reading the picture…" : "Upload or drop a screenshot or photo"}
              </span>
              <span className="text-2xs leading-relaxed text-muted-foreground">
                PNG, JPEG, WebP or GIF up to 4.5 MB. Read by managed UK inference; every box
                becomes a component or a flagged note, every arrow a connection you own.
              </span>
            </button>
            <p className="text-center font-mono text-2xs text-muted-foreground">or paste Mermaid</p>
            <label htmlFor="parse-input" className="sr-only">
              Mermaid flowchart
            </label>
            <textarea
              id="parse-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={"flowchart LR\n  users((Users)) --> web[Web app]\n  web --> db[(Postgres)]"}
              className="min-h-40 resize-none rounded-xl border border-line-strong bg-surface-code p-3.5 font-mono text-xs text-foreground outline-none focus:border-input"
            />
            <input
              ref={fileRef}
              type="file"
              accept=".mmd,.mermaid,.md,text/plain"
              onChange={handleFile}
              className="sr-only"
              aria-label="Open a Mermaid file"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setValue(SAMPLE_MERMAID)}
                  className="rounded font-mono text-xs text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  Load sample
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded font-mono text-xs text-muted-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <Upload className="size-3" aria-hidden /> Open .mmd file
                </button>
              </div>
              <Button size="sm" onClick={() => onParse(value)} disabled={!value.trim()}>
                <FileUp className="size-4" aria-hidden /> Import diagram
              </Button>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Each box is matched to a component by its label and each arrow becomes a
              connection you own. A box Terragram cannot match stays on the diagram, flagged,
              so nothing you drew is silently dropped. draw.io files are not read — screenshot
              them instead.
            </p>
            <p className="pt-2 text-xs font-semibold text-foreground">Or start from a template</p>
            <ul className="flex flex-col gap-2">
              {WORKSPACE_TEMPLATES.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    onClick={() => onStartTemplate?.(template.id)}
                    className="w-full rounded-xl border border-line-strong bg-card p-3 text-left transition-colors hover:border-input hover:bg-surface-subtle focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
                  >
                    <span className="block text-sm font-semibold text-foreground">
                      {template.name}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {template.summary}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
