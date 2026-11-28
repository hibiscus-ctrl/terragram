// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { InfraModel, ModelEdge, ModelNode } from "terragram-engine/model";

/**
 * What changed between two versions of a model, by identity: a node by its id, an edge by
 * its two ends (and "changed" when its origin, its access type or whether it is conditional, or what it gives without the condition, differs). A node is "changed" when something that reaches the Terraform differs
 * (its kind, category, label, attributes, review flag or access to itself); where it sits on the canvas
 * does not count, because moving a box builds nothing different.
 */

export type ModelDiff = {
  nodes: {
    added: ModelNode[];
    removed: ModelNode[];
    changed: { before: ModelNode; after: ModelNode }[];
    unchanged: ModelNode[];
  };
  edges: {
    added: ModelEdge[];
    removed: ModelEdge[];
    changed: { before: ModelEdge; after: ModelEdge }[];
    unchanged: ModelEdge[];
  };
};

function nodeSignature(node: ModelNode, withSelf = true): string {
  const attributes = Object.entries(node.attributes ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const self = withSelf ? [node.selfAccess ?? null, node.selfConditional === true, node.selfUnconditional ?? null] : [];
  return JSON.stringify([node.category, node.kind, node.label, attributes, node.flag?.reason ?? null, ...self]);
}

/** Whether a node's access to itself is all that differs between two versions of it. */
export function onlySelfAccessChanged(before: ModelNode, after: ModelNode): boolean {
  return nodeSignature(before, false) === nodeSignature(after, false);
}

const edgeKey = (edge: ModelEdge) => `${edge.source}\u0000${edge.target}`;
const byId = (a: ModelNode, b: ModelNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function diffModels(base: InfraModel, head: InfraModel): ModelDiff {
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const nodes: ModelDiff["nodes"] = { added: [], removed: [], changed: [], unchanged: [] };
  for (const node of [...head.nodes].sort(byId)) {
    const before = baseNodes.get(node.id);
    if (!before) nodes.added.push(node);
    else if (nodeSignature(before) === nodeSignature(node)) nodes.unchanged.push(node);
    else nodes.changed.push({ before, after: node });
  }
  for (const node of [...base.nodes].sort(byId)) if (!headNodes.has(node.id)) nodes.removed.push(node);

  const baseEdges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  const headEdges = new Map(head.edges.map((e) => [edgeKey(e), e]));
  const edges: ModelDiff["edges"] = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [key, edge] of headEdges) {
    const before = baseEdges.get(key);
    if (!before) edges.added.push(edge);
    else if (before.origin === edge.origin && before.access === edge.access && Boolean(before.conditional) === Boolean(edge.conditional) && before.unconditional === edge.unconditional) edges.unchanged.push(edge);
    else edges.changed.push({ before, after: edge });
  }
  for (const [key, edge] of baseEdges) if (!headEdges.has(key)) edges.removed.push(edge);
  return { nodes, edges };
}

export function hasModelChanges(diff: ModelDiff): boolean {
  return (
    diff.nodes.added.length +
      diff.nodes.removed.length +
      diff.nodes.changed.length +
      diff.edges.added.length +
      diff.edges.removed.length +
      diff.edges.changed.length >
    0
  );
}
