import type { Edge, Node } from "@xyflow/react";
import dagre from "dagre";

import { CATEGORY_META, type InfraModel, type NodeCategory } from "@/features/workspace/model";
import type { EdgeRouting, LabelFace } from "@/features/workspace/settings";

export type CategoryNodeData = {
  category: NodeCategory;
  label: string;
  flagged: boolean;
  /** Dimmed when its category legend toggle is off. */
  hidden: boolean;
  labelFace: LabelFace;
};

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 62;

export type LayoutOptions = {
  edgeRouting?: EdgeRouting;
  labelFace?: LabelFace;
  /** When false, nodes that already have a position are never moved by dagre. */
  autoLayout?: boolean;
};

/**
 * Map the model to React Flow, running dagre only where it is needed.
 *
 * A node that carries a position keeps it: the reviewer put it there, and a diagram
 * that rearranges itself every turn destroys the mental map that makes it useful.
 * Dagre still lays out the nodes that have never been placed, so a new component
 * appears somewhere sensible instead of at the origin.
 */
export function layoutModel(
  model: InfraModel,
  hiddenCategories: Set<NodeCategory>,
  options: LayoutOptions = {},
): { nodes: Node<CategoryNodeData>[]; edges: Edge[] } {
  const autoLayout = options.autoLayout ?? true;
  const labelFace = options.labelFace ?? "mono";

  const pinned = new Map<string, { x: number; y: number }>();
  for (const node of model.nodes) {
    if (node.position) pinned.set(node.id, node.position);
  }

  const needsLayout = model.nodes.filter((n) => !pinned.has(n.id));
  const computed = new Map<string, { x: number; y: number }>();

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

  const nodes: Node<CategoryNodeData>[] = model.nodes.map((node) => ({
    id: node.id,
    type: "category",
    position: pinned.get(node.id) ?? computed.get(node.id) ?? { x: 0, y: 0 },
    data: {
      category: node.category,
      label: node.label,
      flagged: !!node.flag,
      hidden: hiddenCategories.has(node.category),
      labelFace,
    },
    draggable: true,
    selectable: true,
  }));

  const categoryOf = new Map(model.nodes.map((n) => [n.id, n.category]));
  const edges: Edge[] = model.edges.map((edge) => {
    const dimmed =
      hiddenCategories.has(categoryOf.get(edge.source) ?? "edge") ||
      hiddenCategories.has(categoryOf.get(edge.target) ?? "edge");
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: options.edgeRouting ?? "smoothstep",
      // A connection the reviewer drew reads differently from one we inferred, so
      // it looks different: their topology is not our guess.
      style: {
        stroke: edge.origin === "user" ? "var(--primary)" : "#dad3c4",
        strokeWidth: edge.origin === "user" ? 1.8 : 1.5,
        opacity: dimmed ? 0.25 : 1,
      },
      ariaLabel:
        edge.origin === "user"
          ? `Connection you drew, from ${edge.source} to ${edge.target}`
          : `Derived connection from ${edge.source} to ${edge.target}`,
    };
  });

  return { nodes, edges };
}

export function miniMapColor(node: Node<CategoryNodeData>): string {
  return CATEGORY_META[node.data.category].color;
}
