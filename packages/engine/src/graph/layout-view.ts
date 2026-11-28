// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { SEVERITIES } from "./findings.ts";
import { checkIcon, type IconResolver } from "./icons.ts";
import { layoutGraph, type LayoutOptions, type Point } from "./layout.ts";
import { projectGraph, type ProjectOptions } from "./project.ts";
import type { GraphDocument } from "./schema.ts";
import { GRAPH_CATEGORIES } from "./services.ts";
import { cleanText, clip, footerLines, headerLines } from "./text.ts";
import { GRAPH_LEVELS, type GraphView } from "./view.ts";

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

export const GRAPH_LAYOUT_SCHEMA = "diagram.graph-layout/v2";

const severity = z.enum(SEVERITIES);
const status = z.enum(["unchanged", "context", "added", "removed", "changed"]);
const category = z.enum(GRAPH_CATEGORIES);
const level = z.enum(GRAPH_LEVELS);
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
  level: level.describe("How much is drawn: `detailed` a node per resource, `services` a node per service in a box (`Lambda ×12`), `overview` a node per group, with its resources counted by category."),
  focus: z
    .object({
      node: z.string().describe("The id of the node the picture is centred on."),
      label: z.string(),
      hops: z.number().int().min(1).max(3),
      shown: z.number().int().min(1).describe("How many nodes the picture keeps."),
      of: z.number().int().min(1).describe("How many nodes the picture had without the focus."),
    })
    .nullable()
    .describe("Null when the whole picture is here; otherwise the node it was cut to and how far from it."),
  compared: z.boolean().describe("A base graph was given, so `status` and `badges.change` say what changed."),
  width: z.number().int().min(0).describe("The size of the picture, margins included; 0 when nothing is drawn."),
  height: z.number().int().min(0),
  top: z.number().int().min(0).describe("The room the header lines take above the picture: the SVG moves everything down by it."),
  cut: z
    .object({
      maxNodes: z.number().int().min(0).describe("The most nodes a layout holds. At the `overview` and `services` levels a node stands for several resources, so far more resources fit."),
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
      service: z.string().describe("The cloud service of the resource type, for choosing an icon: `aws.rds`, `azure.sql`, `gcp.gke`; `<cloud>.<category>` for a type the engine's table does not know; `terraform.module` for a module call and `terraform.group` for a group's summary node."),
      category,
      icon: z
        .union([z.object({ href: z.string() }), z.object({ symbol: z.string() })])
        .optional()
        .describe("Where the icon the caller's resolver chose for this node is: a URL, a data URI or path (`href`), or the id of an SVG symbol in the page (`symbol`). Absent: draw the glyph of the `category`."),
      aggregate: z
        .object({
          level: z.enum(["overview", "services"]),
          count: z.number().int().min(0).describe("How many nodes of the detailed picture this one stands for."),
          ids: z.array(z.string()).describe("Their ids in the detailed picture of the same document and options (`level: detailed`, no focus), so that a viewer can expand this node."),
          byCategory: z.partialRecord(category, z.number().int().min(1)),
          byStatus: z.partialRecord(status, z.number().int().min(1)).describe("How many of its resources were added, removed, changed or unchanged."),
          types: z.array(z.object({ type: z.string(), count: z.number().int().min(1) })).describe("The resource types among them, the most numerous first."),
          internal: z.number().int().min(0).describe("References between two of its members: not drawn, since both ends are this node."),
        })
        .optional()
        .describe("Present on a node that stands for several resources (the `overview` and `services` levels)."),
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
      status: z.enum(["unchanged", "added", "removed", "changed"]).describe("`changed`: it stands for several references that did not all change the same way."),
      count: z.number().int().min(1).describe("How many references of the detailed picture it stands for: 1 at the `detailed` level."),
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

export type LayoutViewOptions = LayoutOptions & {
  /** Which icon each node gets, when the caller has icons to show (see {@link IconResolver}). Without it the engine draws its own glyph of the node's category. */
  icon?: IconResolver;
};

/** What a card says on its first line: the resource type, or for a card that stands for several resources what they are. */
export function kindOf(node: GraphView["nodes"][number]): string {
  const a = node.aggregate;
  if (a === undefined) return text(node.type);
  if (a.level === "overview") {
    const count = `${a.count} resource${a.count === 1 ? "" : "s"}`;
    return node.type === "resources" ? count : text(`${node.type} · ${count}`);
  }
  const more = a.types.length - 1;
  return text(more > 0 ? `${node.type} +${more} more` : node.type);
}

/** The tooltip of a card that stands for several resources: what they are, by type and by category, and how many changed. */
function aggregateTitle(node: GraphView["nodes"][number], a: NonNullable<GraphView["nodes"][number]["aggregate"]>): string {
  const types = a.types.slice(0, 6).map((t) => `${text(t.type)} ${t.count}`).join(", ");
  const categories = GRAPH_CATEGORIES.flatMap((c) => (a.byCategory[c] ? [`${c} ${a.byCategory[c]}`] : [])).join(", ");
  const changes = (["added", "removed", "changed"] as const).flatMap((s) => (a.byStatus[s] ? [`${a.byStatus[s]} ${s}`] : [])).join(", ");
  const detail = a.level === "services" ? types + (a.types.length > 6 ? `, and ${a.types.length - 6} more` : "") : categories;
  return [`${text(node.label)}: ${a.count} resource${a.count === 1 ? "" : "s"}`, detail, changes].filter(Boolean).join("; ");
}

/** Where everything of a {@link GraphView} sits, the boxes packed toward `options.aspect` (width over height; see {@link LayoutOptions}). */
export function layoutGraphView(view: GraphView, options: LayoutViewOptions = {}): GraphLayoutView {
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
    const kind = kindOf(node);
    // A summary card stands for no one service, so it has no icon to ask for.
    const icon =
      options.icon === undefined || node.aggregate?.level === "overview"
        ? undefined
        : checkIcon(options.icon({ id: node.id, cloud: view.cloud, type: node.type, service: node.service, category: node.category, level: view.level }));
    const aggregate = node.aggregate;
    nodes.push({
      id: node.id,
      kind,
      service: node.service,
      category: node.category,
      ...(icon !== undefined && { icon }),
      ...(aggregate !== undefined && {
        aggregate: { ...aggregate, types: aggregate.types.map((t) => ({ type: text(t.type), count: t.count })) },
      }),
      label,
      title:
        aggregate === undefined
          ? [`${kind} ${label}`, node.region ? `region ${text(node.region)}` : "", node.status === "unchanged" ? "" : node.status].filter(Boolean).join(", ")
          : [aggregateTitle(node, aggregate), node.region ? `region ${text(node.region)}` : "", node.status === "unchanged" ? "" : node.status].filter(Boolean).join(", "),
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
    count: edge.count,
    points: (layout?.edges[i] ?? []).map((p: Point) => ({ x: p.x, y: p.y })),
  }));

  return {
    schema: GRAPH_LAYOUT_SCHEMA,
    cloud: view.cloud,
    ...(view.title !== undefined && { title: text(view.title, LINE_LIMIT) }),
    mode: view.mode,
    level: view.level,
    focus: view.focus ? { ...view.focus, node: text(view.focus.node), label: text(view.focus.label) } : null,
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

/** The layout of a `graph/v1` document, with the options {@link projectGraph} takes (a base to compare with, findings, glue, delta, a title, the `level` and a `focus`), the `aspect` to pack toward and an `icon` resolver. */
export function layoutGraphDocument(doc: GraphDocument, options: ProjectOptions & LayoutViewOptions = {}): GraphLayoutView {
  const { aspect, icon, ...project } = options;
  return layoutGraphView(projectGraph(doc, project), { ...(aspect !== undefined && { aspect }), ...(icon !== undefined && { icon }) });
}
