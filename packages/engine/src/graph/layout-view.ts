// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { SEVERITIES } from "./findings.ts";
import { layoutGraph, type LayoutOptions, type Point } from "./layout.ts";
import { type GraphView, projectGraph, type ProjectOptions } from "./project.ts";
import type { GraphDocument } from "./schema.ts";
import { cleanText, clip, footerLines, headerLines } from "./text.ts";

/**
 * Where everything of an estate sits, as plain data: `diagram.graph-layout/v1`. The SVG, draw.io file and Mermaid
 * flowchart are drawn from the same view, and the SVG is drawn *from this*, so a viewer that places these
 * rectangles (a React Flow canvas, say) draws the picture the engine draws, to the pixel.
 *
 * - Coordinates are the SVG's: whole numbers, `x` and `y` of a rectangle's top-left corner, the origin at the top-left
 *   of the picture. A title or a summary line above the picture pushes everything down by `top`; a viewer that draws
 *   no such text may subtract it. A group's rectangle contains the rectangles of what is in it.
 * - Every string is text, not markup: control characters are dropped and nothing is clipped or shortened except the
 *   way the SVG shortens it (`label` is what a card shows, `heading` what a box shows). Nothing is XML-escaped, so a
 *   viewer must render a string as text (React does) and never as HTML.
 * - Bounded: an estate of more than {@link MAX_GRAPH_NODES} resources is cut to its first ones, and `cut` says how many
 *   of the cards and references were left out.
 * - Deterministic: the same document and options give the same bytes, whatever order the document lists its nodes in.
 */

export const GRAPH_LAYOUT_SCHEMA = "diagram.graph-layout/v1";

const severity = z.enum(SEVERITIES);
const status = z.enum(["unchanged", "context", "added", "removed", "changed"]);
const rect = { x: z.number().int(), y: z.number().int(), width: z.number().int().min(0), height: z.number().int().min(0) };

const findingBadge = z
  .object({
    count: z.number().int().min(1).describe("How many findings sit on this node or box."),
    worst: severity,
    bySeverity: z.partialRecord(severity, z.number().int().min(1)).describe("How many of each severity."),
  })
  .describe("Findings placed on a node, or on a box and what is inside it.");

const badges = z.object({
  change: z.enum(["added", "removed", "changed"]).nullable().describe("What a comparison with the base graph found, or null."),
  findings: findingBadge.nullable(),
});

export const graphLayoutSchema = z.object({
  schema: z.literal(GRAPH_LAYOUT_SCHEMA),
  cloud: z.enum(["aws", "azure", "google"]),
  title: z.string().optional(),
  mode: z.enum(["full", "delta"]),
  compared: z.boolean().describe("A base graph was given, so `status` and `badges.change` say what changed."),
  width: z.number().int().min(0).describe("The size of the picture, margins included; 0 when nothing is drawn."),
  height: z.number().int().min(0),
  top: z.number().int().min(0).describe("The room the header lines take above the picture: the SVG moves everything down by it."),
  cut: z
    .object({
      maxNodes: z.number().int().min(0).describe("The most nodes a layout holds."),
      nodes: z.number().int().min(1).describe("Nodes left out."),
      edges: z.number().int().min(0).describe("Edges left out because an end was."),
    })
    .nullable()
    .describe("Null when the whole estate is here; otherwise how much of it was left out."),
  header: z.array(z.string()).describe("The lines above the picture."),
  footer: z.array(z.string()).describe("The lines below the picture: what was hidden or cut, and what the findings are."),
  groups: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["scope", "environment", "module"]).describe("An account, subscription or project; an environment; a module call."),
      label: z.string(),
      detail: z.string().optional().describe("A module call's version."),
      heading: z.string().describe("The text the SVG writes on the box's top edge."),
      parent: z.string().nullable().describe("The id of the box this one is inside."),
      status,
      badges,
      ...rect,
    }),
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      kind: z.string().describe("The resource type, or `module call`."),
      category: z.enum(["network", "compute", "storage", "identity", "data", "other"]),
      label: z.string().describe("The short name of a card, at most 40 characters; the SVG draws 24 of them, with the middle left out of a longer one."),
      title: z.string().describe("The tooltip: type, label, region and status."),
      group: z.string().describe("The id of the box this node is inside."),
      region: z.string().optional(),
      environment: z.string().optional(),
      status,
      badges,
      ...rect,
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string().describe("The id of the node that refers to the other."),
      target: z.string(),
      kind: z.literal("reference"),
      status: z.enum(["unchanged", "added", "removed"]),
      points: z.array(z.object({ x: z.number(), y: z.number() })).describe("The route the SVG draws, from the source to the target; empty when none was found."),
    }),
  ),
  hidden: z.object({
    count: z.number().int().min(0).describe("Glue resources left out of the picture."),
    types: z.array(z.object({ type: z.string(), count: z.number().int().min(1) })),
  }),
  changes: z
    .object({
      nodesAdded: z.number().int().min(0),
      nodesRemoved: z.number().int().min(0),
      nodesChanged: z.number().int().min(0),
      edgesAdded: z.number().int().min(0),
      edgesRemoved: z.number().int().min(0),
    })
    .optional(),
  findings: z
    .object({ total: z.number().int().min(0), unplaced: z.number().int().min(0), bySeverity: z.partialRecord(severity, z.number().int().min(1)) })
    .optional(),
});

export type GraphLayoutView = z.infer<typeof graphLayoutSchema>;
export type LayoutNode = GraphLayoutView["nodes"][number];
export type LayoutGroup = GraphLayoutView["groups"][number];
export type LayoutEdge = GraphLayoutView["edges"][number];

const TEXT_LIMIT = 200;
const LINE_LIMIT = 400;
const text = (value: string, max = TEXT_LIMIT) => clip(cleanText(value), max);
const change = (s: GraphView["nodes"][number]["status"]) => (s === "added" || s === "removed" || s === "changed" ? s : null);

/** The heading of a box, as the SVG writes it: what it is, a module's version, what changed, clipped to the box's width. */
function headingOf(group: GraphView["groups"][number], width: number): string {
  const changed = group.status === "unchanged" || group.status === "context" ? "" : ` [${group.status}]`;
  const full = `${text(group.label)}${group.detail ? ` ${text(group.detail)}` : ""}${changed}`;
  return clip(full, Math.max(12, Math.floor((width - 56) / 6.6)));
}

/** Where everything of a {@link GraphView} sits, the boxes packed toward `options.aspect` (width over height; see {@link LayoutOptions}). */
export function layoutGraphView(view: GraphView, options: LayoutOptions = {}): GraphLayoutView {
  const header = headerLines(view).map((line) => text(line, LINE_LIMIT));
  const top = header.length * 18 + (header.length > 0 ? 6 : 0);
  const layout = view.nodes.length === 0 ? undefined : layoutGraph(view, top, options);

  const groups: LayoutGroup[] = [];
  for (const group of view.groups) {
    const box = layout?.groups.get(group.id);
    if (box === undefined) continue;
    groups.push({
      id: group.id,
      kind: group.kind,
      label: text(group.label),
      ...(group.detail !== undefined && { detail: text(group.detail) }),
      heading: headingOf(group, box.width),
      parent: group.parent,
      status: group.status,
      badges: { change: change(group.status), findings: group.findings },
      ...box,
    });
  }
  const nodes: LayoutNode[] = [];
  for (const node of view.nodes) {
    const box = layout?.nodes.get(node.id);
    if (box === undefined) continue;
    const label = text(node.label);
    const kind = text(node.type);
    nodes.push({
      id: node.id,
      kind,
      category: node.category,
      label,
      title: [`${kind} ${label}`, node.region ? `region ${text(node.region)}` : "", node.status === "unchanged" ? "" : node.status].filter(Boolean).join(", "),
      group: node.group,
      ...(node.region !== undefined && { region: text(node.region) }),
      ...(node.environment !== undefined && { environment: text(node.environment) }),
      status: node.status,
      badges: { change: change(node.status), findings: node.findings },
      ...box,
    });
  }
  const edges: LayoutEdge[] = view.edges.map((edge, i) => ({
    id: `e${i}`,
    source: edge.from,
    target: edge.to,
    kind: "reference",
    status: edge.status,
    points: (layout?.edges[i] ?? []).map((p: Point) => ({ x: p.x, y: p.y })),
  }));

  return {
    schema: GRAPH_LAYOUT_SCHEMA,
    cloud: view.cloud,
    ...(view.title !== undefined && { title: text(view.title, LINE_LIMIT) }),
    mode: view.mode,
    compared: view.compared,
    width: layout ? Math.ceil(layout.width) : 0,
    height: layout ? Math.ceil(layout.height) : 0,
    top,
    cut: view.cut ?? null,
    header,
    footer: footerLines(view).map((line) => text(line, LINE_LIMIT)),
    groups,
    nodes,
    edges,
    hidden: { count: view.hidden.count, types: view.hidden.types.map((t) => ({ type: text(t.type), count: t.count })) },
    ...(view.changes && { changes: view.changes }),
    ...(view.findings && { findings: view.findings }),
  };
}

/** The layout of a `graph/v1` document, with the options {@link projectGraph} takes (a base to compare with, findings, glue, delta, a title) and the `aspect` to pack toward. */
export function layoutGraphDocument(doc: GraphDocument, options: ProjectOptions & LayoutOptions = {}): GraphLayoutView {
  const { aspect, ...project } = options;
  return layoutGraphView(projectGraph(doc, project), aspect === undefined ? {} : { aspect });
}
