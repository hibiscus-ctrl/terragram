// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { drawioIconStyle } from "./drawio-shapes.ts";
import { type Box, layoutGraph, type LayoutOptions } from "./layout.ts";
import { kindOf } from "./layout-view.ts";
import { GRAPH_CATEGORIES } from "./services.ts";
import { CATEGORY_COLOUR, EDGE_STYLE, GROUP_STYLE, INK, MUTED, STATUS_STYLE } from "./svg.ts";
import { CARD_KIND_CHARS, CARD_LABEL_CHARS, clipMiddle, footerLines, headerLines } from "./text.ts";
import type { GraphView, ViewGroup, ViewNode } from "./view.ts";

/**
 * A {@link GraphView} as a draw.io (diagrams.net) file: uncompressed `mxfile` XML, with the
 * scopes, environments and module calls as containers, the resources as cards inside them
 * and the references as connectors between the cards. The positions are the ones the SVG
 * uses (`layoutGraph`), so the two pictures match; a card sits relative to its container
 * as draw.io expects, and a connector keeps the waypoints dagre routed it by. The bytes
 * depend only on the view.
 *
 * A card whose service draw.io has a shape for (see `drawio-shapes.ts`) carries that shape as a small cell inside it, which
 * draw.io draws from its own AWS, Azure or Google Cloud library: the file holds the shape's name and no art.
 *
 * Every label is plain text (no `html=1`, so draw.io never reads it as markup) and goes
 * through {@link attr}. Only what the picture already says is written: a card has its type,
 * its label and its status and findings, and no other attribute of the resource.
 */

/** A value for an XML attribute: characters XML 1.0 cannot hold dropped, markup escaped, and a line break (`\n`) kept as a character reference. */
function attr(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") out += "&#10;";
    else if (ch === "\t") out += " ";
    else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) continue;
    else if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";
    else out += ch;
  }
  return out;
}

/** A draw.io style string from fixed keys and values (never from user text). */
const style = (entries: Record<string, string | number | undefined>): string =>
  `${Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(";")};`;

function groupHeading(group: ViewGroup): string {
  const status = group.status === "unchanged" || group.status === "context" ? "" : ` [${group.status}]`;
  const findings = group.findings ? ` [${group.findings.count} ${group.findings.worst}]` : "";
  return `${group.label}${group.detail ? ` ${group.detail}` : ""}${status}${findings}`;
}

function cardLabel(node: ViewNode): string {
  const mark = STATUS_STYLE[node.status].mark;
  const findings = node.findings ? ` [${node.findings.count} ${node.findings.worst}]` : "";
  const counts = node.aggregate?.level === "overview" ? GRAPH_CATEGORIES.flatMap((c) => (node.aggregate?.byCategory[c] ? [`${c} ${node.aggregate.byCategory[c]}`] : [])).join(", ") : "";
  return `${mark ? `${mark} ` : ""}${clipMiddle(kindOf(node), CARD_KIND_CHARS)}\n${clipMiddle(node.label, CARD_LABEL_CHARS)}${findings}${counts ? `\n${counts}` : ""}`;
}

/** The draw.io style of the shape a card carries, if its service has one and it is a card of resources (a summary card stands for no service). */
const iconStyleOf = (node: ViewNode) => (node.aggregate?.level === "overview" ? undefined : drawioIconStyle(node.service));

const ICON_SIZE = 32;

const geometry = (box: Box, parent?: Box): string =>
  `<mxGeometry x="${box.x - (parent?.x ?? 0)}" y="${box.y - (parent?.y ?? 0)}" width="${box.width}" height="${box.height}" as="geometry"/>`;

function groupCell(group: ViewGroup, box: Box, parent: Box | undefined): string {
  const status = STATUS_STYLE[group.status];
  const [plainStroke, plainFill, plainDash] = GROUP_STYLE[group.kind];
  const dash = status.dash ?? plainDash;
  const css = style({
    rounded: 1,
    arcSize: 6,
    whiteSpace: "wrap",
    container: 1,
    collapsible: 0,
    recursiveResize: 0,
    align: "left",
    verticalAlign: "top",
    spacingLeft: 12,
    spacingTop: 2,
    fontSize: 11,
    fontStyle: 1,
    fontColor: MUTED,
    fillColor: status.stroke ? status.fill : plainFill,
    strokeColor: status.stroke ?? plainStroke,
    dashed: dash ? 1 : undefined,
    dashPattern: dash || undefined,
  });
  return `<mxCell id="${attr(group.id)}" value="${attr(groupHeading(group))}" style="${css}" vertex="1" parent="${attr(group.parent ?? "1")}">${geometry(box, parent)}</mxCell>`;
}

function nodeCell(node: ViewNode, box: Box, parent: Box): string {
  const status = STATUS_STYLE[node.status];
  const icon = iconStyleOf(node);
  const css = style({
    rounded: 1,
    arcSize: 12,
    whiteSpace: "wrap",
    align: "left",
    verticalAlign: "middle",
    spacingLeft: icon === undefined ? 12 : ICON_SIZE + 20,
    fontSize: icon === undefined ? 11 : 10,
    fontStyle: node.status === "removed" ? 9 : 1,
    fontColor: node.status === "removed" ? MUTED : INK,
    fillColor: status.fill,
    strokeColor: status.stroke ?? CATEGORY_COLOUR[node.category],
    strokeWidth: 1.5,
    dashed: status.dash ? 1 : undefined,
    dashPattern: status.dash,
    opacity: node.status === "context" ? 55 : undefined,
  });
  const card = `<mxCell id="${attr(node.id)}" value="${attr(cardLabel(node))}" style="${css}" vertex="1" parent="${attr(node.group)}">${geometry(box, parent)}</mxCell>`;
  if (icon === undefined) return card;
  const shape = `<mxCell id="${attr(node.id)}-icon" value="" style="${icon}" vertex="1" parent="${attr(node.id)}"><mxGeometry x="10" y="${Math.round((box.height - ICON_SIZE) / 2)}" width="${ICON_SIZE}" height="${ICON_SIZE}" as="geometry"/></mxCell>`;
  return `${card}\n        ${shape}`;
}

function textCell(id: string, text: string, x: number, y: number, width: number, emphasis: boolean): string {
  const css = style({
    align: "left",
    verticalAlign: "top",
    whiteSpace: "wrap",
    fontSize: emphasis ? 14 : 10,
    fontStyle: emphasis ? 1 : 0,
    fontColor: emphasis ? INK : MUTED,
    strokeColor: "none",
    fillColor: "none",
  });
  return `<mxCell id="${id}" value="${attr(text)}" style="text;${css}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="18" as="geometry"/></mxCell>`;
}

export function renderGraphDrawio(view: GraphView, options: LayoutOptions = {}): string {
  const head = headerLines(view);
  const top = head.length * 18 + (head.length > 0 ? 6 : 0);
  const layout = view.nodes.length === 0 ? undefined : layoutGraph(view, top, options);
  const foot = footerLines(view);
  const width = Math.ceil(Math.max(layout?.width ?? 0, 360)) - 48;

  const cells: string[] = [];
  head.forEach((line, i) => {
    cells.push(textCell(`h${i}`, line, 24, 20 + i * 18, width, i === 0 && view.title !== undefined));
  });

  if (layout) {
    const emit = (group: ViewGroup) => {
      const box = layout.groups.get(group.id);
      if (box === undefined) return;
      cells.push(groupCell(group, box, group.parent === null ? undefined : layout.groups.get(group.parent)));
      for (const child of view.groups) if (child.parent === group.id) emit(child);
      for (const node of view.nodes) {
        const at = layout.nodes.get(node.id);
        if (node.group === group.id && at) cells.push(nodeCell(node, at, box));
      }
    };
    for (const group of view.groups) if (group.parent === null) emit(group);

    view.edges.forEach((edge, i) => {
      const line = EDGE_STYLE[edge.status];
      const css = style({
        curved: 1,
        endArrow: "block",
        endFill: 1,
        strokeColor: line.stroke,
        strokeWidth: line.width,
        dashed: line.dash ? 1 : undefined,
        dashPattern: line.dash,
        ...(edge.count > 1 && { fontSize: 10, fontStyle: 1, fontColor: INK, labelBackgroundColor: "#faf8f4" }),
      });
      const waypoints = (layout.edges[i] ?? []).slice(1, -1);
      const points = waypoints.length === 0 ? "" : `<Array as="points">${waypoints.map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join("")}</Array>`;
      cells.push(`<mxCell id="e${i}" value="${edge.count > 1 ? attr(`×${edge.count}`) : ""}" style="${css}" edge="1" source="${attr(edge.from)}" target="${attr(edge.to)}" parent="1"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`);
    });
  } else {
    cells.push(textCell("empty", view.mode === "delta" ? "No changes." : "No resources to draw.", 24, top + 24, width, false));
  }
  const bottom = (layout?.height ?? top + 56) + 4;
  foot.forEach((line, i) => {
    cells.push(textCell(`f${i}`, line, 24, bottom + i * 16, width, false));
  });

  const name = view.title ?? "Infrastructure graph";
  return [
    `<mxfile>`,
    `  <diagram id="diagram-graph" name="${attr(name)}">`,
    `    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">`,
    `      <root>`,
    `        <mxCell id="0"/>`,
    `        <mxCell id="1" parent="0"/>`,
    ...cells.map((cell) => `        ${cell}`),
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
    ``,
  ].join("\n");
}
