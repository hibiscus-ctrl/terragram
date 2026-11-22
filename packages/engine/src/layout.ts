// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import dagre from "dagre";

import type { InfraModel } from "./model.ts";

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 62;

export type Position = { x: number; y: number };

export type LayoutOptions = {
  /** When false, nodes that already have a position are never moved by dagre. */
  autoLayout?: boolean;
};

/**
 * Where every node of the model sits, running dagre only where it is needed.
 *
 * A node that carries a position keeps it: the reviewer put it there, and a diagram
 * that rearranges itself every turn destroys the mental map that makes it useful.
 * Dagre still lays out the nodes that have never been placed, so a new component
 * appears somewhere sensible instead of at the origin.
 *
 * This is the renderer-neutral half of the canvas layout: the live canvas maps the
 * result to React Flow, the SVG export draws it directly.
 */
export function layoutPositions(model: InfraModel, options: LayoutOptions = {}): Map<string, Position> {
  const autoLayout = options.autoLayout ?? true;

  const pinned = new Map<string, Position>();
  for (const node of model.nodes) {
    if (node.position) pinned.set(node.id, node.position);
  }

  const needsLayout = model.nodes.filter((n) => !pinned.has(n.id));
  const computed = new Map<string, Position>();

  if (needsLayout.length > 0 && !autoLayout) {
    // Auto-layout off: place new nodes in a column below whatever is already on the
    // canvas and touch nothing else, so adding a component never moves the rest.
    const lowest = [...pinned.values()].reduce((y, p) => Math.max(y, p.y), 0);
    needsLayout.forEach((node, index) => {
      computed.set(node.id, { x: 0, y: lowest + (index + 1) * (NODE_HEIGHT + 40) });
    });
  } else if (needsLayout.length > 0) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 44, ranksep: 60, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));

    // Lay out the whole graph so new nodes land in the right rank relative to
    // pinned ones, then take positions only for the nodes that need them.
    for (const node of model.nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of model.edges) {
      if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target);
    }
    dagre.layout(g);
    for (const node of needsLayout) {
      const pos = g.node(node.id);
      computed.set(node.id, {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      });
    }
  }

  return new Map(
    model.nodes.map((node) => [node.id, pinned.get(node.id) ?? computed.get(node.id) ?? { x: 0, y: 0 }]),
  );
}
