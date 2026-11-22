// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Cloud } from "./model.ts";

/** The four translation directions. One model, switchable any time. */
export const WORKSPACE_MODES = [
  "chat-diagram",
  "chat-terraform",
  "diagram-terraform",
  "terraform-diagram",
] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export type WorkspaceFormat = "chat" | "diagram" | "terraform";

/** Chip tokens per format — shared with the marketing homepage so they never drift. */
export const FORMAT_CHIP: Record<WorkspaceFormat, string> = {
  chat: "bg-cat-security-bg text-cat-security",
  diagram: "bg-cat-storage-bg text-cat-storage",
  terraform: "bg-cat-network-bg text-cat-network",
};

export const FORMAT_LABEL: Record<WorkspaceFormat, string> = {
  chat: "Chat",
  diagram: "Diagram",
  terraform: "Terraform",
};

export type ModeMeta = {
  id: WorkspaceMode;
  from: WorkspaceFormat;
  to: WorkspaceFormat;
  title: string;
  body: string;
};

export const MODE_META: Record<WorkspaceMode, ModeMeta> = {
  "chat-diagram": {
    id: "chat-diagram",
    from: "chat",
    to: "diagram",
    title: "Chat to Diagram",
    body: "Describe your architecture and watch the diagram build itself.",
  },
  "chat-terraform": {
    id: "chat-terraform",
    from: "chat",
    to: "terraform",
    title: "Chat to Terraform",
    body: "Describe it in plain English and get review-ready Terraform.",
  },
  "diagram-terraform": {
    id: "diagram-terraform",
    from: "diagram",
    to: "terraform",
    title: "Diagram to Terraform",
    body: "Upload a screenshot, paste a Mermaid flowchart or start from a template, then generate compliant IaC.",
  },
  "terraform-diagram": {
    id: "terraform-diagram",
    from: "terraform",
    to: "diagram",
    title: "Terraform to Diagram",
    body: "Paste existing Terraform and reverse-engineer the diagram.",
  },
};

export const MODE_LIST: ModeMeta[] = WORKSPACE_MODES.map((id) => MODE_META[id]);

export function isWorkspaceMode(value: string | null | undefined): value is WorkspaceMode {
  return !!value && (WORKSPACE_MODES as readonly string[]).includes(value);
}

export function formatLabel(f: WorkspaceFormat): string {
  return FORMAT_LABEL[f];
}

/** The compact "Chat → Diagram" label used on the workspace mode pill. */
export function modeArrowLabel(mode: WorkspaceMode): string {
  const m = MODE_META[mode];
  return `${FORMAT_LABEL[m.from]} → ${FORMAT_LABEL[m.to]}`;
}

/** True when the mode produces Terraform (so the workspace drives toward code-gen). */
export function targetsTerraform(mode: WorkspaceMode): boolean {
  return MODE_META[mode].to === "terraform";
}

/** True when the mode starts from an existing artefact the user provides (paste/upload). */
export function startsFromArtefact(mode: WorkspaceMode): boolean {
  return MODE_META[mode].from === "diagram" || MODE_META[mode].from === "terraform";
}

export const CLOUD_LABEL: Record<Cloud, string> = {
  azure: "Azure",
  aws: "AWS",
};
