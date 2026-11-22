// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Cloud } from "terragram-engine/model";

import { COMMENT_MARKER } from "./comment.ts";
import type { Inputs } from "./inputs.ts";
import type { Diagram } from "./mermaid.ts";
import { hasModelChanges, type ModelDiff } from "./model-diff.ts";
import type { FileState } from "./terraform-files.ts";

/**
 * The markdown the Action reports with: the sticky pull-request comment and the job's
 * step summary are the same text (the comment adds a marker).
 */

export type BaseState =
  /** Not a pull request: there is no base to compare with. */
  | { state: "none" }
  | { state: "compared" }
  /** The model file is new in this pull request. */
  | { state: "new" }
  | { state: "unavailable"; reason: string };

export type ReportInput = {
  mode: Inputs["mode"];
  modelPath: string;
  terraformDir: string;
  cloud: Cloud;
  base: BaseState;
  diff: ModelDiff | null;
  diagram: Diagram;
  /** One line per component that needs attention (cannot be built, or flagged for review). */
  warnings: string[];
  /** Generated files whose content differs between the base model's Terraform and the head's. */
  terraformChanged: string[];
  files: FileState[];
  /** Files `write` mode changed. */
  written: string[];
  contentHash: string;
  signed: boolean;
};

const MAX_LISTED = 12;
const MAX_DIFF_CHARS = 24_000;

/** Text from a model file, safe in a markdown table cell or list item. */
export function markdownText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]<>()#+!|~&@]/g, (char) => `&#${char.codePointAt(0)};`);
}

function listed<T>(items: readonly T[], render: (item: T) => string): string[] {
  const shown = items.slice(0, MAX_LISTED).map((item) => `- ${render(item)}`);
  if (items.length > MAX_LISTED) shown.push(`- and ${items.length - MAX_LISTED} more`);
  return shown;
}

function statusLine(input: ReportInput): string {
  const dir = `\`${input.terraformDir}\``;
  const drifted = input.files.filter((f) => f.status !== "same").length;
  if (input.mode === "write") {
    return input.written.length > 0
      ? `Regenerated ${dir}: ${input.written.length} ${input.written.length === 1 ? "file" : "files"} written.`
      : `${dir} already matches the model: nothing written.`;
  }
  return drifted === 0
    ? `${dir} matches \`${input.modelPath}\`.`
    : `${dir} differs from \`${input.modelPath}\` in ${drifted} ${drifted === 1 ? "file" : "files"}. Regenerate it and commit the result.`;
}

function modelSection(input: ReportInput): string[] {
  const { base, diff, diagram } = input;
  if (base.state === "none") return [];
  const out = ["### Model changes", ""];
  if (base.state === "unavailable") {
    out.push(`The model could not be compared with the base: ${markdownText(base.reason)}.`, "");
    return out;
  }
  if (base.state === "new") out.push(`\`${input.modelPath}\` is new in this pull request, so every component is added.`, "");
  if (!diff || !hasModelChanges(diff)) {
    out.push("The model is unchanged.", "");
    return out;
  }
  if (diagram.mermaid) {
    out.push("```mermaid", diagram.mermaid, "```", "");
    out.push(
      diagram.scope === "changes"
        ? "The model is too large to draw whole, so only what changed and the components beside it are shown."
        : "",
      "Green: added. Red, dashed: removed. Amber: changed.",
      "",
    );
  } else if (diagram.scope === "omitted") {
    out.push("The diagram is too large to draw; the table below has the counts.", "");
  }
  const nodes = diff.nodes;
  const edges = diff.edges;
  out.push(
    "| | Added | Removed | Changed |",
    "| --- | ---: | ---: | ---: |",
    `| Nodes | ${nodes.added.length} | ${nodes.removed.length} | ${nodes.changed.length} |`,
    `| Edges | ${edges.added.length} | ${edges.removed.length} | ${edges.changed.length} |`,
    "",
  );
  if (nodes.changed.length > 0) {
    out.push(
      ...listed(nodes.changed, ({ before, after }) => {
        const what =
          before.label !== after.label
            ? `"${markdownText(before.label)}" to "${markdownText(after.label)}"`
            : `${markdownText(before.kind)} to ${markdownText(after.kind)}`;
        return `\`${before.id.replaceAll("`", "'")}\` changed: ${what}`;
      }),
      "",
    );
  }
  return out;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = ["## Diagram", "", statusLine(input), ""];
  lines.push(...modelSection(input));

  const hasBase = input.base.state === "compared" || input.base.state === "new";
  lines.push("### Summary", "", "| | |", "| --- | --- |");
  lines.push(`| Cloud | ${input.cloud} |`);
  lines.push(`| Feasibility warnings | ${input.warnings.length} |`);
  if (hasBase) {
    lines.push(`| Terraform files changed by this model change | ${input.terraformChanged.length} |`);
  }
  const drifted = input.files.filter((f) => f.status !== "same");
  lines.push(`| Terraform files differing from \`${input.terraformDir}\` | ${drifted.length} |`);
  lines.push(`| Receipt | \`${input.contentHash}\` (${input.signed ? "signed" : "unsigned"}) |`, "");

  if (input.warnings.length > 0) {
    lines.push("<details><summary>Feasibility warnings</summary>", "", ...listed(input.warnings, markdownText), "", "</details>", "");
  }
  if (hasBase && input.terraformChanged.length > 0) {
    lines.push(
      "<details><summary>Terraform files changed by this model change</summary>",
      "",
      ...listed(input.terraformChanged, (name) => `\`${markdownText(name)}\``),
      "",
      "</details>",
      "",
    );
  }
  if (drifted.length > 0 && input.mode === "check") {
    let budget = MAX_DIFF_CHARS;
    const diffs: string[] = [];
    for (const file of drifted) {
      const text = file.diff.length > budget ? `${file.diff.slice(0, Math.max(0, budget))}\n(diff cut short)\n` : file.diff;
      budget -= text.length;
      // A diff line can hold a backtick run, so the fence is longer than any in the text.
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      diffs.push(`${fence}diff\n${text}${fence}`);
      if (budget <= 0) break;
    }
    lines.push("<details><summary>Difference from the committed Terraform</summary>", "", ...diffs, "", "</details>", "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function commentBody(report: string): string {
  return `${COMMENT_MARKER}\n${report}`;
}
