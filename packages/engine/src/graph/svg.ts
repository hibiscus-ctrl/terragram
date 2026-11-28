// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { CATEGORY_META } from "../model.ts";
import { SEVERITIES, type Severity } from "./findings.ts";
import { HEADER, type LayoutOptions, type Point } from "./layout.ts";
import { type LayoutGroup, type LayoutNode, layoutGraphView } from "./layout-view.ts";
import { CARD_KIND_CHARS, CARD_LABEL_CHARS, cleanText, clipMiddle } from "./text.ts";
import type { EdgeStatus, GraphCategory, GraphStatus, GraphView, ViewGroup, ViewNode } from "./project.ts";

/**
 * A {@link GraphView} as a standalone SVG: no script, no external font or image, and the
 * same bytes for the same view. What a status or a finding means is said in words as
 * well as colour (a `+`, `-` or `~` on the card, a count on the finding's marker, a
 * legend below), so a printed or colour-blind reader loses nothing.
 */

const FONT = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
export const INK = "#211d16";
export const MUTED = "#665e4f";
const PAPER = "#faf8f4";

export const CATEGORY_COLOUR: Record<GraphCategory, string> = {
  network: CATEGORY_META.network.color,
  compute: CATEGORY_META.compute.color,
  storage: CATEGORY_META.storage.color,
  identity: CATEGORY_META.identity.color,
  data: "#be185d",
  other: CATEGORY_META.edge.color,
};

const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: "#7f1d1d",
  high: "#b91c1c",
  medium: "#b45309",
  low: "#a16207",
  info: "#475569",
};

export const STATUS_STYLE: Record<GraphStatus, { stroke?: string; fill: string; dash?: string; mark?: string }> = {
  unchanged: { fill: "#ffffff" },
  context: { fill: "#ffffff" },
  added: { stroke: "#15803d", fill: "#f0fdf4", mark: "+" },
  removed: { stroke: "#b91c1c", fill: "#fef2f2", dash: "4 3", mark: "-" },
  changed: { stroke: "#b45309", fill: "#fffbeb", mark: "~" },
};

/** Stroke, fill and dash of a box that did not change: each level of the nesting a shade darker. */
export const GROUP_STYLE: Record<ViewGroup["kind"], readonly [string, string, string]> = {
  scope: ["#cfc7b4", "#f6f3ec", ""],
  environment: ["#c9bfa6", "#f1ede2", "2 3"],
  module: ["#c4baa0", "#efe9da", "6 4"],
};

export const EDGE_STYLE: Record<EdgeStatus, { stroke: string; width: number; dash?: string }> = {
  unchanged: { stroke: "#a8a090", width: 1.5 },
  added: { stroke: "#15803d", width: 2 },
  removed: { stroke: "#b91c1c", width: 2, dash: "5 4" },
};

/** Text for XML: control characters dropped (they are not legal there), markup escaped. */
function esc(text: string): string {
  return cleanText(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const num = (n: number) => String(Math.round(n * 10) / 10);

/** A smooth line through the points dagre routed, ending at the last one. */
function curve(points: readonly Point[]): string {
  const [first, ...rest] = points;
  if (first === undefined || rest.length === 0) return "";
  const mid = (a: Point, b: Point) => `${num((a.x + b.x) / 2)} ${num((a.y + b.y) / 2)}`;
  let d = `M ${num(first.x)} ${num(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const at = points[i] as Point;
    const next = points[i + 1];
    if (next === undefined) d += ` L ${num(at.x)} ${num(at.y)}`;
    else d += ` Q ${num(at.x)} ${num(at.y)} ${mid(at, next)}`;
  }
  return d;
}

function findingsTitle(tally: NonNullable<ViewNode["findings"]>): string {
  const parts = SEVERITIES.flatMap((s) => (tally.bySeverity[s] ? [`${tally.bySeverity[s]} ${s}`] : []));
  return `${tally.count} finding${tally.count === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** The marker for findings: a pill with the count, coloured by the worst severity. */
function marker(tally: NonNullable<ViewNode["findings"]>, right: number, y: number): string {
  const label = String(tally.count);
  const width = 12 + label.length * 7;
  const x = right - width / 2;
  return `<g><title>${esc(findingsTitle(tally))}</title><rect x="${num(x)}" y="${num(y - 8)}" width="${width}" height="16" rx="8" fill="${SEVERITY_COLOUR[tally.worst]}"/><text x="${num(x + width / 2)}" y="${num(y + 4)}" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="700" fill="#ffffff">${label}</text></g>`;
}

function groupSvg(group: LayoutGroup): string {
  const style = STATUS_STYLE[group.status];
  const [plainStroke, plainFill, plainDash] = GROUP_STYLE[group.kind];
  const stroke = style.stroke ?? plainStroke;
  const fill = style.stroke ? style.fill : plainFill;
  const dash = style.dash ?? plainDash;
  const right = group.x + group.width - 10;
  return `<g><rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.25"${dash ? ` stroke-dasharray="${dash}"` : ""}/>
<text x="${group.x + 12}" y="${group.y + HEADER - 7}" font-family="${FONT}" font-size="11" font-weight="700" fill="${MUTED}">${esc(group.heading)}</text>${group.badges.findings ? marker(group.badges.findings, right, group.y + HEADER / 2 + 1) : ""}
</g>`;
}

function nodeSvg(node: LayoutNode): string {
  const colour = CATEGORY_COLOUR[node.category];
  const style = STATUS_STYLE[node.status];
  const stroke = style.stroke ?? colour;
  const faded = node.status === "context" ? ' opacity="0.55"' : "";
  const { x, y } = node;
  const strike = node.status === "removed" ? ' text-decoration="line-through"' : "";
  const mark = style.mark
    ? `<circle cx="${x}" cy="${y}" r="8" fill="${stroke}"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#ffffff">${style.mark}</text>`
    : "";
  return `<g${faded}><title>${esc(node.title)}</title>
<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="9" fill="${style.fill}" stroke="${stroke}" stroke-width="1.5"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>
<rect x="${x}" y="${y + 10}" width="4" height="${node.height - 20}" rx="2" fill="${colour}"/>
<text x="${x + 14}" y="${y + 24}" font-family="${FONT}" font-size="9" font-weight="600" fill="${colour}" letter-spacing="0.3"${strike}>${esc(clipMiddle(node.kind, CARD_KIND_CHARS))}</text>
<text x="${x + 14}" y="${y + 46}" font-family="${FONT}" font-size="12" font-weight="700" fill="${INK}"${strike}>${esc(clipMiddle(node.label, CARD_LABEL_CHARS))}</text>${mark}${node.badges.findings ? marker(node.badges.findings, x + node.width - 6, y) : ""}
</g>`;
}

function legend(view: GraphView, y: number): string {
  const items: { colour: string; text: string }[] = [];
  if (view.compared) {
    items.push({ colour: "#15803d", text: "+ added" }, { colour: "#b91c1c", text: "- removed" }, { colour: "#b45309", text: "~ changed" });
  }
  for (const s of SEVERITIES) if (view.findings?.bySeverity[s]) items.push({ colour: SEVERITY_COLOUR[s], text: s });
  let x = 24;
  return items
    .map((item) => {
      const out = `<rect x="${num(x)}" y="${y - 9}" width="10" height="10" rx="2" fill="${item.colour}"/><text x="${num(x + 15)}" y="${y}" font-family="${FONT}" font-size="10" fill="${MUTED}">${esc(item.text)}</text>`;
      x += 15 + item.text.length * 6.2 + 14;
      return out;
    })
    .join("\n");
}

/** The picture of `view`, its boxes packed toward `options.aspect` (width over height; see {@link LayoutOptions}). */
export function renderGraphSvg(view: GraphView, options: LayoutOptions = {}): string {
  const layout = layoutGraphView(view, options);
  const head = layout.header;
  const top = layout.top;
  const empty = view.nodes.length === 0;
  const foot = layout.footer;
  const message = empty ? (view.mode === "delta" ? "No changes." : "No resources to draw.") : "";

  const bodyWidth = empty ? 360 : layout.width;
  const bodyHeight = empty ? top + 56 : layout.height;
  const keyItems = legend(view, 0) !== "";
  const footTop = bodyHeight + 4;
  const width = Math.ceil(Math.max(bodyWidth, 360));
  const height = Math.ceil(footTop + foot.length * 16 + (keyItems ? 24 : 0) + 12);

  const parts: string[] = [];
  head.forEach((line, i) => {
    parts.push(`<text x="24" y="${24 + i * 18}" font-family="${FONT}" font-size="${i === 0 && view.title ? 14 : 11}" font-weight="${i === 0 && view.title ? 700 : 400}" fill="${i === 0 && view.title ? INK : MUTED}">${esc(line)}</text>`);
  });
  if (!empty) {
    for (const group of layout.groups) parts.push(groupSvg(group));
    for (const edge of layout.edges) {
      const d = curve(edge.points);
      if (d === "") continue;
      const s = EDGE_STYLE[edge.status];
      parts.push(`<path d="${d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""} marker-end="url(#tg-arrow-${edge.status})"/>`);
    }
    for (const node of layout.nodes) parts.push(nodeSvg(node));
  } else {
    parts.push(`<text x="24" y="${top + 36}" font-family="${FONT}" font-size="12" fill="${MUTED}">${message}</text>`);
  }
  foot.forEach((line, i) => {
    parts.push(`<text x="24" y="${footTop + 12 + i * 16}" font-family="${FONT}" font-size="10" fill="${MUTED}">${esc(line)}</text>`);
  });
  if (keyItems) parts.push(legend(view, footTop + foot.length * 16 + 20));

  const description = `${view.nodes.length} resource${view.nodes.length === 1 ? "" : "s"} in ${view.groups.length} group${view.groups.length === 1 ? "" : "s"}, ${view.edges.length} reference${view.edges.length === 1 ? "" : "s"}.`;
  const markers = (Object.keys(EDGE_STYLE) as EdgeStatus[])
    .map((status) => `<marker id="tg-arrow-${status}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${EDGE_STYLE[status].stroke}"/></marker>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tg-title tg-desc">
<title id="tg-title">${esc(view.title ?? "Infrastructure graph")}</title>
<desc id="tg-desc">${esc(description)}</desc>
<defs>${markers}</defs>
<rect width="${width}" height="${height}" fill="${PAPER}"/>
${parts.join("\n")}
</svg>`;
}
