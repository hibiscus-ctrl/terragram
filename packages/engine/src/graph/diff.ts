// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_GLUE, type GlueRule } from "./glue.ts";
import { compareText, type NormalGraph, type NormalNode, normalizeGraph } from "./normalize.ts";
import type { GraphDocument } from "./schema.ts";

/** A node as the diff names it: the key is stable across documents of the same estate. */
type GraphNodeRef = NormalNode;
type GraphEdgeRef = { from: string; to: string };

export type GraphDiff = {
  nodes: {
    added: GraphNodeRef[];
    removed: GraphNodeRef[];
    /** Same node in both, with a different region, module version, module call, environment or root. */
    changed: { before: GraphNodeRef; after: GraphNodeRef }[];
  };
  edges: { added: GraphEdgeRef[]; removed: GraphEdgeRef[] };
};

/** What about a node a diff compares: everything but its key and its address, which a hashed graph changes from run to run. */
const fingerprint = (n: NormalNode) => [n.region ?? "", n.version ?? "", n.container ?? "", n.environment ?? ""].join("|");

/**
 * Whether a node moved to another root. Only when both graphs name the root: a graph from
 * before infraharvest wrote roots has none, and that is not every node moving.
 */
const rootMoved = (before: NormalNode, after: NormalNode) =>
  before.root !== undefined && after.root !== undefined && before.root !== after.root;

export function diffNormal(base: NormalGraph, head: NormalGraph): GraphDiff {
  const diff: GraphDiff = { nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [] } };
  for (const [key, after] of head.nodes) {
    const before = base.nodes.get(key);
    if (before === undefined) diff.nodes.added.push(after);
    else if (fingerprint(before) !== fingerprint(after) || rootMoved(before, after)) diff.nodes.changed.push({ before, after });
  }
  for (const [key, before] of base.nodes) {
    if (!head.nodes.has(key)) diff.nodes.removed.push(before);
  }
  for (const [key, edge] of head.edges) if (!base.edges.has(key)) diff.edges.added.push(edge);
  for (const [key, edge] of base.edges) if (!head.edges.has(key)) diff.edges.removed.push(edge);
  const byKey = (a: { key: string }, b: { key: string }) => compareText(a.key, b.key);
  const byEdge = (a: GraphEdgeRef, b: GraphEdgeRef) => compareText(`${a.from} ${a.to}`, `${b.from} ${b.to}`);
  diff.nodes.added.sort(byKey);
  diff.nodes.removed.sort(byKey);
  diff.nodes.changed.sort((a, b) => byKey(a.after, b.after));
  diff.edges.added.sort(byEdge);
  diff.edges.removed.sort(byEdge);
  return diff;
}

/**
 * What changed between two graphs of the same estate: the nodes and the references that
 * were added, removed, or (for a node) moved to another region, module call, environment, root or module
 * version. Glue resources are left out of both sides by the same rule the picture uses,
 * so a new policy attachment is not a change; pass `glue: false` to count them.
 */
export function diffGraphs(
  base: GraphDocument,
  head: GraphDocument,
  options: { glue?: Readonly<GlueRule> | false } = {},
): GraphDiff {
  const glue = options.glue === undefined ? DEFAULT_GLUE : options.glue;
  return diffNormal(normalizeGraph(base, glue), normalizeGraph(head, glue));
}
