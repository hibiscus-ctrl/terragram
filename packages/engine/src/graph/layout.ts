// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import dagre from "dagre";

import { NODE_HEIGHT, NODE_WIDTH } from "../layout.ts";
import type { GraphView } from "./project.ts";

/**
 * Where everything of a {@link GraphView} sits. The nodes are laid out by dagre as a
 * compound graph (so a scope's and a module call's members stay together, and the lines
 * between them are routed around the boxes), and each box is then drawn around its
 * members with room for its label. dagre keeps what it lays out in the order it is given,
 * and the view is in the order of its places (scope, environment, module path, address, key), so the same view gives the same layout; every number is
 * rounded so that no float arithmetic reaches the output.
 */

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export type GraphLayout = {
  width: number;
  height: number;
  /** By node id. */
  nodes: Map<string, Box>;
  /** By group id. */
  groups: Map<string, Box>;
  /** In the order of the view's edges. */
  edges: Point[][];
};

const MARGIN = 24;
/** Room above the first thing in a box, for its label. */
export const HEADER = 22;
const PAD = 14;
const NODE_GAP = 40;
const RANK_GAP = 72;

const round = (n: number) => Math.round(n);

export function layoutGraph(view: GraphView, top = 0): GraphLayout {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: "TB", nodesep: NODE_GAP, ranksep: RANK_GAP, edgesep: 20, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const group of view.groups) g.setNode(group.id, {});
  for (const group of view.groups) if (group.parent !== null) g.setParent(group.id, group.parent);
  for (const node of view.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    g.setParent(node.id, node.group);
  }
  for (const edge of view.edges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);

  const nodes = new Map<string, Box>();
  for (const node of view.nodes) {
    const at = g.node(node.id);
    nodes.set(node.id, {
      x: round(at.x - NODE_WIDTH / 2),
      y: round(at.y - NODE_HEIGHT / 2),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  // A box is its members' box, grown by the padding and the label, children before parents.
  const groups = new Map<string, Box>();
  const grow = (id: string): Box | undefined => {
    const members: Box[] = [
      ...view.nodes.filter((n) => n.group === id).flatMap((n) => nodes.get(n.id) ?? []),
      ...view.groups.filter((c) => c.parent === id).flatMap((c) => grow(c.id) ?? []),
    ];
    if (members.length === 0) return undefined;
    const left = Math.min(...members.map((b) => b.x)) - PAD;
    const right = Math.max(...members.map((b) => b.x + b.width)) + PAD;
    const bottom = Math.max(...members.map((b) => b.y + b.height)) + PAD;
    const upper = Math.min(...members.map((b) => b.y)) - PAD - HEADER;
    const box = { x: left, y: upper, width: right - left, height: bottom - upper };
    groups.set(id, box);
    return box;
  };
  for (const group of view.groups) if (group.parent === null) grow(group.id);

  const edges = view.edges.map((edge) => (g.edge(edge.from, edge.to)?.points ?? []).map((p) => ({ x: p.x, y: p.y })));

  // Move everything so that the top-left of what is drawn is at the margin, below `top`.
  const boxes = [...nodes.values(), ...groups.values()];
  const points = edges.flat();
  const minX = Math.min(...boxes.map((b) => b.x), ...points.map((p) => p.x));
  const minY = Math.min(...boxes.map((b) => b.y), ...points.map((p) => p.y));
  const dx = MARGIN - minX;
  const dy = MARGIN + top - minY;
  const move = (b: Box): Box => ({ ...b, x: round(b.x + dx), y: round(b.y + dy) });
  const moved = {
    nodes: new Map([...nodes].map(([id, b]) => [id, move(b)])),
    groups: new Map([...groups].map(([id, b]) => [id, move(b)])),
    edges: edges.map((line) => line.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) }))),
  };
  const placed = [...moved.nodes.values(), ...moved.groups.values()];
  const reach = [...placed.map((b) => b.x + b.width), ...moved.edges.flat().map((p) => p.x)];
  const low = [...placed.map((b) => b.y + b.height), ...moved.edges.flat().map((p) => p.y)];
  return { ...moved, width: Math.max(0, ...reach) + MARGIN, height: Math.max(0, ...low) + MARGIN };
}
