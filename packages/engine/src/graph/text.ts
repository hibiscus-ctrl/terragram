// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { SEVERITIES } from "./findings.ts";
import type { GraphView } from "./project.ts";

/** The text every picture of a {@link GraphView} shares, so that the SVG, the draw.io file and the layout say the same words. */

/** Text with the control characters dropped (a tab is kept): what no format can hold, and what a reader should never see. Markup is the writer's to escape. */
export function cleanText(text: string): string {
  return [...text].filter((ch) => ch >= " " || ch === "\t").join("");
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The words under the picture: what was hidden, what the findings are, what the colours mean. */
export function footerLines(view: GraphView): string[] {
  const lines: string[] = [];
  if (view.mode === "delta") lines.push("Delta view: what changed, and the resources one reference away from it.");
  if (view.cut) {
    const { maxNodes, nodes, edges } = view.cut;
    lines.push(`Cut to the first ${maxNodes} resources: ${nodes} more and ${edges} reference${edges === 1 ? "" : "s"} are not drawn.`);
  }
  if (view.hidden.count > 0) {
    const shown = view.hidden.types.slice(0, 4).map((t) => `${t.type} x${t.count}`);
    const more = view.hidden.types.length - shown.length;
    lines.push(`${view.hidden.count} glue resource${view.hidden.count === 1 ? "" : "s"} hidden: ${shown.join(", ")}${more > 0 ? `, and ${more} more type${more === 1 ? "" : "s"}` : ""}.`);
  }
  if (view.findings) {
    const parts = SEVERITIES.flatMap((s) => (view.findings?.bySeverity[s] ? [`${view.findings.bySeverity[s]} ${s}`] : []));
    const placed = view.findings.total - view.findings.unplaced;
    lines.push(`Findings: ${placed} placed${parts.length > 0 ? ` (${parts.join(", ")})` : ""}${view.findings.unplaced > 0 ? `, ${view.findings.unplaced} not placed` : ""}.`);
  }
  return lines;
}

export function headerLines(view: GraphView): string[] {
  const lines: string[] = [];
  if (view.title) lines.push(view.title);
  if (view.changes) {
    const c = view.changes;
    lines.push(`Resources +${c.nodesAdded} -${c.nodesRemoved} ~${c.nodesChanged}, references +${c.edgesAdded} -${c.edgesRemoved}`);
  }
  return lines;
}
