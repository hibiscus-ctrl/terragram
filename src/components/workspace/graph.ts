// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Edge, Node } from "@xyflow/react";
import { layoutPositions } from "terragram-engine/layout";
import { CATEGORY_META, type InfraModel, type NodeCategory } from "terragram-engine/model";
import type { EdgeRouting, LabelFace } from "terragram-engine/settings";

export type CategoryNodeData = {
  category: NodeCategory;
  label: string;
  flagged: boolean;
  /** Dimmed when its category legend toggle is off. */
  hidden: boolean;
  labelFace: LabelFace;
};

export type LayoutOptions = {
  edgeRouting?: EdgeRouting;
  labelFace?: LabelFace;
  /** When false, nodes that already have a position are never moved by dagre. */
  autoLayout?: boolean;
};

/**
 * Map the model to React Flow. Positions come from the engine's `layoutPositions`,
 * which keeps every node the reviewer already placed and runs dagre only for the rest.
 */
export function layoutModel(
  model: InfraModel,
  hiddenCategories: Set<NodeCategory>,
  options: LayoutOptions = {},
): { nodes: Node<CategoryNodeData>[]; edges: Edge[] } {
  const labelFace = options.labelFace ?? "mono";
  const positions = layoutPositions(
    model,
    options.autoLayout === undefined ? {} : { autoLayout: options.autoLayout },
  );

  const nodes: Node<CategoryNodeData>[] = model.nodes.map((node) => ({
    id: node.id,
    type: "category",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
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
