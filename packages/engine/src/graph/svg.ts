// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { NODE_HEIGHT, NODE_WIDTH } from "../layout.ts";
import { CATEGORY_META } from "../model.ts";
import { SEVERITIES, type Severity } from "./findings.ts";
import { type Box, HEADER, layoutGraph, type Point } from "./layout.ts";
import type { EdgeStatus, GraphCategory, GraphStatus, GraphView, ViewGroup, ViewNode } from "./project.ts";

/**
 * A {@link GraphView} as a standalone SVG: no script, no external font or image, and the
 * same bytes for the same view. What a status or a finding means is said in words as
 * well as colour (a `+`, `-` or `~` on the card, a count on the finding's marker, a
 * legend below), so a printed or colour-blind reader loses nothing.
 */

const FONT = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const INK = "#211d16";
const MUTED = "#665e4f";
const PAPER = "#faf8f4";

const CATEGORY_COLOUR: Record<GraphCategory, string> = {
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

const STATUS_STYLE: Record<GraphStatus, { stroke?: string; fill: string; dash?: string; mark?: string }> = {
  unchanged: { fill: "#ffffff" },
  context: { fill: "#ffffff" },
  added: { stroke: "#15803d", fill: "#f0fdf4", mark: "+" },
  removed: { stroke: "#b91c1c", fill: "#fef2f2", dash: "4 3", mark: "-" },
  changed: { stroke: "#b45309", fill: "#fffbeb", mark: "~" },
};

const EDGE_STYLE: Record<EdgeStatus, { stroke: string; width: number; dash?: string }> = {
  unchanged: { stroke: "#a8a090", width: 1.5 },
  added: { stroke: "#15803d", width: 2 },
  removed: { stroke: "#b91c1c", width: 2, dash: "5 4" },
};

/** Text for XML: control characters dropped (they are not legal there), markup escaped. */
function esc(text: string): string {
  const clean = [...text].filter((ch) => ch >= " " || ch === "\t").join("");
  return clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

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

function groupSvg(group: ViewGroup, box: Box): string {
  const style = STATUS_STYLE[group.status];
  const isScope = group.kind === "scope";
  const stroke = style.stroke ?? (isScope ? "#cfc7b4" : "#c4baa0");
  const fill = style.stroke ? style.fill : isScope ? "#f6f3ec" : "#efe9da";
  const dash = style.dash ?? (isScope ? "" : "6 4");
  const status = group.status === "unchanged" || group.status === "context" ? "" : ` [${group.status}]`;
  const heading = `${group.label}${group.detail ? ` ${group.detail}` : ""}${status}`;
  const right = box.x + box.width - 10;
  return `<g><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.25"${dash ? ` stroke-dasharray="${dash}"` : ""}/>
<text x="${box.x + 12}" y="${box.y + HEADER - 7}" font-family="${FONT}" font-size="11" font-weight="700" fill="${MUTED}">${esc(clip(heading, Math.max(12, Math.floor((box.width - 56) / 6.6))))}</text>${group.findings ? marker(group.findings, right, box.y + HEADER / 2 + 1) : ""}
</g>`;
}

function nodeSvg(node: ViewNode, box: Box): string {
  const colour = CATEGORY_COLOUR[node.category];
  const style = STATUS_STYLE[node.status];
  const stroke = style.stroke ?? colour;
  const faded = node.status === "context" ? ' opacity="0.55"' : "";
  const title = [`${node.type} ${node.label}`, node.region ? `region ${node.region}` : "", node.status === "unchanged" ? "" : node.status]
    .filter(Boolean)
    .join(", ");
  const { x, y } = box;
  const strike = node.status === "removed" ? ' text-decoration="line-through"' : "";
  const mark = style.mark
    ? `<circle cx="${x}" cy="${y}" r="8" fill="${stroke}"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#ffffff">${style.mark}</text>`
    : "";
  return `<g${faded}><title>${esc(title)}</title>
<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="9" fill="${style.fill}" stroke="${stroke}" stroke-width="1.5"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>
<rect x="${x}" y="${y + 10}" width="4" height="${NODE_HEIGHT - 20}" rx="2" fill="${colour}"/>
<text x="${x + 14}" y="${y + 24}" font-family="${FONT}" font-size="9" font-weight="600" fill="${colour}" letter-spacing="0.3"${strike}>${esc(clip(node.type, 26))}</text>
<text x="${x + 14}" y="${y + 46}" font-family="${FONT}" font-size="12" font-weight="700" fill="${INK}"${strike}>${esc(clip(node.label, 20))}</text>${mark}${node.findings ? marker(node.findings, x + NODE_WIDTH - 6, y) : ""}
</g>`;
}

/** The words under the picture: what was hidden, what the findings are, what the colours mean. */
function footerLines(view: GraphView): string[] {
  const lines: string[] = [];
  if (view.mode === "delta") lines.push("Delta view: what changed, and the resources one reference away from it.");
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

function headerLines(view: GraphView): string[] {
  const lines: string[] = [];
  if (view.title) lines.push(view.title);
  if (view.changes) {
    const c = view.changes;
    lines.push(`Resources +${c.nodesAdded} -${c.nodesRemoved} ~${c.nodesChanged}, references +${c.edgesAdded} -${c.edgesRemoved}`);
  }
  return lines;
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

export function renderGraphSvg(view: GraphView): string {
  const head = headerLines(view);
  const top = head.length * 18 + (head.length > 0 ? 6 : 0);
  const empty = view.nodes.length === 0;
  const layout = empty ? undefined : layoutGraph(view, top);
  const foot = footerLines(view);
  const message = empty ? (view.mode === "delta" ? "No changes." : "No resources to draw.") : "";

  const bodyWidth = layout?.width ?? 360;
  const bodyHeight = layout?.height ?? top + 56;
  const keyItems = legend(view, 0) !== "";
  const footTop = bodyHeight + 4;
  const width = Math.ceil(Math.max(bodyWidth, 360));
  const height = Math.ceil(footTop + foot.length * 16 + (keyItems ? 24 : 0) + 12);

  const parts: string[] = [];
  head.forEach((line, i) => {
    parts.push(`<text x="24" y="${24 + i * 18}" font-family="${FONT}" font-size="${i === 0 && view.title ? 14 : 11}" font-weight="${i === 0 && view.title ? 700 : 400}" fill="${i === 0 && view.title ? INK : MUTED}">${esc(line)}</text>`);
  });
  if (layout) {
    for (const group of view.groups) {
      const box = layout.groups.get(group.id);
      if (box) parts.push(groupSvg(group, box));
    }
    view.edges.forEach((edge, i) => {
      const d = curve(layout.edges[i] ?? []);
      if (d === "") return;
      const s = EDGE_STYLE[edge.status];
      parts.push(`<path d="${d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""} marker-end="url(#tg-arrow-${edge.status})"/>`);
    });
    for (const node of view.nodes) {
      const box = layout.nodes.get(node.id);
      if (box) parts.push(nodeSvg(node, box));
    }
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
