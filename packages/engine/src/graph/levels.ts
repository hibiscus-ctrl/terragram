// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type FindingTally, mergeTallies } from "./findings.ts";
import { compareText } from "./normalize.ts";
import { serviceLabel } from "./services.ts";
import {
  type EdgeStatus,
  type FocusOptions,
  GRAPH_LEVELS,
  type GraphCategory,
  type GraphLevel,
  type GraphStatus,
  type GraphView,
  MAX_FOCUS_HOPS,
  type ViewAggregate,
  type ViewEdge,
  type ViewGroup,
  type ViewNode,
} from "./view.ts";

/**
 * What a picture draws, reshaped after the detailed picture is projected: the Overview and Services levels fold the
 * resources into cards that stand for several, a focus keeps a node and what is near it, and a cut keeps the first cards.
 * All three work on a {@link GraphView} and give one, so a comparison (the statuses, the delta) and the findings come
 * through them unchanged: a card that stands for resources that changed in different ways says `changed`, and its
 * `aggregate.byStatus` says how many of each.
 *
 * Every order is the detailed view's: a card is placed where its first member was, and ids are numbered in that order.
 */

/** A level, a focus or a node that the picture does not have: the caller's mistake, said in words. */
export class GraphViewError extends Error {
  override name = "GraphViewError";
}

const SEPARATOR = "\u0000";

/** What several statuses add up to: the one they share, else `changed` when any of them is a change. */
function combineStatus(statuses: readonly GraphStatus[]): GraphStatus {
  const first = statuses[0] ?? "unchanged";
  if (statuses.every((s) => s === first)) return first;
  return statuses.some((s) => s === "added" || s === "removed" || s === "changed") ? "changed" : "unchanged";
}

function combineEdgeStatus(statuses: readonly EdgeStatus[]): EdgeStatus {
  const first = statuses[0] ?? "unchanged";
  return statuses.every((s) => s === first) ? first : "changed";
}

/** The one value all of them have, or undefined when they differ. */
function shared(values: readonly (string | undefined)[]): string | undefined {
  const first = values[0];
  return values.every((v) => v === first) ? first : undefined;
}

function countBy<T extends string>(items: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function aggregateOf(level: "overview" | "services", members: readonly ViewNode[]): ViewAggregate {
  const types = new Map<string, number>();
  for (const m of members) types.set(m.type, (types.get(m.type) ?? 0) + 1);
  return {
    level,
    count: members.length,
    ids: members.map((m) => m.id),
    byCategory: countBy<GraphCategory>(members.map((m) => m.category)),
    byStatus: countBy<GraphStatus>(members.map((m) => m.status)),
    types: [...types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || compareText(a.type, b.type)),
    internal: 0,
  };
}

/** A card of the new picture: what it stands for, and the card itself once it has an id. */
type Plan = { members: readonly ViewNode[]; card: (id: string, aggregate: ViewAggregate) => ViewNode };

/**
 * Builds the picture of cards that stand for several nodes. A plan with one member and no say in the matter
 * (`keep`) leaves that node as it is, with its own id; every other plan is a card `a0`, `a1`, ... in the order of the plans.
 */
function fold(view: GraphView, level: "overview" | "services", plans: readonly (Plan & { keep?: true })[]): Pick<GraphView, "nodes" | "edges"> {
  const nodes: ViewNode[] = [];
  const cardOf = new Map<string, string>();
  const aggregates = new Map<string, ViewAggregate>();
  let next = 0;
  for (const plan of plans) {
    const only = plan.members[0];
    if (plan.keep && plan.members.length === 1 && only !== undefined) {
      nodes.push(only);
      cardOf.set(only.id, only.id);
      continue;
    }
    const id = `a${next++}`;
    const aggregate = aggregateOf(level, plan.members);
    aggregates.set(id, aggregate);
    nodes.push(plan.card(id, aggregate));
    for (const m of plan.members) cardOf.set(m.id, id);
  }

  const place = new Map(nodes.map((n, i) => [n.id, i]));
  const lines = new Map<string, { from: string; to: string; count: number; statuses: EdgeStatus[] }>();
  for (const edge of view.edges) {
    const from = cardOf.get(edge.from);
    const to = cardOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const inside = aggregates.get(from);
    if (from === to && inside !== undefined) {
      inside.internal += edge.count;
      continue;
    }
    const key = `${from}${SEPARATOR}${to}`;
    const line = lines.get(key) ?? { from, to, count: 0, statuses: [] };
    line.count += edge.count;
    line.statuses.push(edge.status);
    lines.set(key, line);
  }
  const edges: ViewEdge[] = [...lines.values()]
    .sort((a, b) => (place.get(a.from) ?? 0) - (place.get(b.from) ?? 0) || (place.get(a.to) ?? 0) - (place.get(b.to) ?? 0))
    .map((line) => ({ from: line.from, to: line.to, status: combineEdgeStatus(line.statuses), count: line.count }));
  return { nodes, edges };
}

/** Services: inside each box, the resources of one service become one card (`Lambda ×12`); a service of one resource keeps its card. */
function byService(view: GraphView): Pick<GraphView, "nodes" | "edges"> {
  const parts = new Map<string, ViewNode[]>();
  for (const node of view.nodes) {
    const key = `${node.group}${SEPARATOR}${node.service}`;
    parts.set(key, [...(parts.get(key) ?? []), node]);
  }
  const plans = [...parts.values()].map((members): Plan & { keep: true } => ({
    members,
    keep: true,
    card: (id, aggregate) => {
      const first = members[0] as ViewNode;
      const region = shared(members.map((m) => m.region));
      const environment = shared(members.map((m) => m.environment));
      return {
        id,
        group: first.group,
        type: aggregate.types[0]?.type ?? first.type,
        label: `${serviceLabel(first.service)} ×${members.length}`,
        service: first.service,
        category: first.category,
        ...(region !== undefined && { region }),
        ...(environment !== undefined && { environment }),
        status: combineStatus(members.map((m) => m.status)),
        findings: mergeTallies(members.map((m) => m.findings)),
        aggregate,
      };
    },
  }));
  return fold(view, "services", plans);
}

/**
 * The name a group's summary card shows: the group's label without the word that its kind line already says, a module's
 * registry source (`namespace/name/provider`) without its namespace, and its version.
 */
function nameOf(group: ViewGroup): string {
  const bare = group.label.startsWith(`${group.kind} `) ? group.label.slice(group.kind.length + 1) : group.label;
  const parts = group.kind === "module" ? bare.split("/") : [];
  const name = parts.length === 3 ? parts.slice(1).join("/") : bare;
  return group.detail === undefined ? name : `${name} ${group.detail}`;
}

/**
 * Overview: a box with no box inside it becomes one summary card, in the box around it; a box with boxes inside it, and a
 * scope (which has nothing around it), stays a box, with one summary card for the resources that sit directly in it.
 */
function byGroup(view: GraphView): Pick<GraphView, "groups" | "nodes" | "edges"> {
  const hasChildren = new Set(view.groups.map((g) => g.parent).filter((p): p is string => p !== null));
  const kept = view.groups.filter((g) => g.parent === null || hasChildren.has(g.id));
  const kindsInside = new Map<string, Set<string>>();
  for (const g of view.groups) if (g.parent !== null) kindsInside.set(g.parent, (kindsInside.get(g.parent) ?? new Set()).add(g.kind));
  /** What the resources that sit directly in a box are not in: the boxes inside it. */
  const looseName = (id: string) => (kindsInside.get(id)?.has("environment") ? "not in an environment" : kindsInside.has(id) ? "not in a module" : "resources");
  const keptIds = new Set(kept.map((g) => g.id));
  const plans: Plan[] = [];
  for (const group of view.groups) {
    const members = view.nodes.filter((n) => n.group === group.id);
    const stays = keptIds.has(group.id);
    if (stays && members.length === 0) continue;
    plans.push({
      members,
      card: (id, aggregate) => {
        const own = stays ? [] : [group.findings];
        const changed = !stays && (group.status === "added" || group.status === "removed" || group.status === "changed") ? [group.status] : [];
        const findings: FindingTally | null = mergeTallies([...own, ...members.map((m) => m.findings)]);
        return {
          id,
          group: stays ? group.id : (group.parent ?? group.id),
          type: stays ? "resources" : group.kind,
          label: stays ? looseName(group.id) : nameOf(group),
          service: "terraform.group",
          category: "other",
          status: combineStatus([...members.map((m) => m.status), ...changed]),
          findings,
          aggregate,
        };
      },
    });
  }
  return { groups: kept, ...fold(view, "overview", plans) };
}

/**
 * The picture at `level`: `detailed` is the view as it is. A view that is already folded cannot be folded again,
 * so this is only for a detailed view.
 */
export function atLevel(view: GraphView, level: GraphLevel): GraphView {
  if (!GRAPH_LEVELS.includes(level)) throw new GraphViewError(`level must be one of ${GRAPH_LEVELS.join(", ")}`);
  if (level === "detailed") return view;
  return { ...view, level, ...(level === "services" ? byService(view) : byGroup(view)) };
}

/** `view` with only the nodes in `keep`, the references between them and the boxes around them. */
function restrict(view: GraphView, keep: ReadonlySet<string>): Pick<GraphView, "groups" | "nodes" | "edges"> {
  const nodes = view.nodes.filter((n) => keep.has(n.id));
  const parentOf = new Map(view.groups.map((g) => [g.id, g.parent]));
  const used = new Set<string>();
  for (const node of nodes) {
    for (let id: string | null | undefined = node.group; id !== null && id !== undefined && !used.has(id); id = parentOf.get(id)) used.add(id);
  }
  return {
    groups: view.groups.filter((g) => used.has(g.id)),
    nodes,
    edges: view.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

/** The view's first `maxNodes` cards, the references between them and the boxes around them; `cut` says what was left out. */
export function cutView(view: GraphView, maxNodes: number): GraphView {
  const limit = Math.max(0, Math.floor(maxNodes));
  if (view.nodes.length <= limit) return view;
  const kept = restrict(view, new Set(view.nodes.slice(0, limit).map((n) => n.id)));
  return {
    ...view,
    ...kept,
    cut: { maxNodes: limit, nodes: view.nodes.length - kept.nodes.length, edges: view.edges.length - kept.edges.length },
  };
}

/** The node a focus names: by its id in this picture, else by a label that only one node has. */
function findFocus(view: GraphView, name: string): ViewNode {
  const byId = view.nodes.find((n) => n.id === name);
  if (byId !== undefined) return byId;
  const byLabel = view.nodes.filter((n) => n.label === name);
  if (byLabel.length === 1 && byLabel[0] !== undefined) return byLabel[0];
  if (byLabel.length > 1) throw new GraphViewError(`${byLabel.length} nodes are labelled "${name}": give a node id (${byLabel.slice(0, 3).map((n) => n.id).join(", ")}) from the layout`);
  throw new GraphViewError(`there is no node "${name}" in this picture (level ${view.level}${view.mode === "delta" ? ", delta" : ""}): give a node id from its layout`);
}

/**
 * Only `focus.node` and the nodes within `focus.hops` references of it, a reference followed in either direction, with the
 * references between them and the boxes around them. The ids are the ones the picture has without the focus, so a viewer that
 * asks for a focus on a node it drew gets the same ids back.
 */
export function focusView(view: GraphView, focus: FocusOptions): GraphView {
  const hops = focus.hops ?? 1;
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_FOCUS_HOPS) throw new RangeError(`focus hops must be a whole number from 1 to ${MAX_FOCUS_HOPS}`);
  if (typeof focus.node !== "string" || focus.node === "") throw new GraphViewError("focus needs a node");
  const start = findFocus(view, focus.node);

  const near = new Map<string, string[]>();
  for (const edge of view.edges) {
    near.set(edge.from, [...(near.get(edge.from) ?? []), edge.to]);
    near.set(edge.to, [...(near.get(edge.to) ?? []), edge.from]);
  }
  const reached = new Set([start.id]);
  let ring = [start.id];
  for (let hop = 0; hop < hops && ring.length > 0; hop++) {
    const following: string[] = [];
    for (const id of ring) {
      for (const other of near.get(id) ?? []) {
        if (reached.has(other)) continue;
        reached.add(other);
        following.push(other);
      }
    }
    ring = following;
  }
  return {
    ...view,
    ...restrict(view, reached),
    focus: { node: start.id, label: start.label, hops, shown: reached.size, of: view.nodes.length },
  };
}
