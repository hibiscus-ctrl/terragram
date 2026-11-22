// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { uniqueNodeId } from "./engine.ts";
import { fieldsForKind, type KindField, kindDefinition } from "./kinds.ts";
import type { InfraModel, ModelEdge, ModelNode } from "./model.ts";

/**
 * Model edits made from the canvas and the node inspector.
 *
 * These are what turn the review gate from a screen into an actual gate: the
 * flagged Postgres node asks for a compute tier, you pick one, the flag clears, and
 * the generated HCL reflects it. The structural edits (add, connect, delete) are the
 * same idea applied to topology — and the moment one of them lands the model is
 * marked `manual`, so no later chat turn quietly re-derives the graph you drew.
 */

export { fieldsForKind };

/** Current value of an attribute for a node — the reviewer's choice, else the fallback. */
export function attributeValue(node: ModelNode, field: KindField): string {
  return node.attributes?.[field.key] ?? field.fallback;
}

function mapNode(model: InfraModel, id: string, fn: (n: ModelNode) => ModelNode): InfraModel {
  return { ...model, nodes: model.nodes.map((n) => (n.id === id ? fn(n) : n)) };
}

/** Set a node's display label (the inspector "Service" field). */
export function setNodeLabel(model: InfraModel, id: string, label: string): InfraModel {
  const trimmed = label.trim().slice(0, 160);
  if (!trimmed) return model;
  return mapNode(model, id, (n) => ({ ...n, label: trimmed }));
}

/** Set one reviewer-confirmed attribute on a node. */
export function setNodeAttribute(
  model: InfraModel,
  id: string,
  key: string,
  value: string,
): InfraModel {
  return mapNode(model, id, (n) => ({
    ...n,
    attributes: { ...n.attributes, [key]: value },
  }));
}

/** Clear a node's review flag — the inspector's "Mark resolved". */
export function resolveNodeFlag(model: InfraModel, id: string): InfraModel {
  return mapNode(model, id, (n) => ({ ...n, flag: null }));
}

/** Remember where a node was dragged to, so the layout survives the next turn. */
export function setNodePosition(
  model: InfraModel,
  id: string,
  position: { x: number; y: number },
): InfraModel {
  return mapNode(model, id, (n) => ({ ...n, position }));
}

/* --------------------------------------------------------- structural edits -- */

/** Add a node of `kind`, optionally at a canvas position. Marks topology manual. */
export function addNode(
  model: InfraModel,
  kind: string,
  position?: { x: number; y: number },
): { model: InfraModel; id: string } | null {
  const definition = kindDefinition(kind);
  if (!definition || definition.role === "conceptual" || definition.role === "external") {
    return null;
  }
  const id = uniqueNodeId(kind, model.nodes.map((n) => n.id));
  const node: ModelNode = {
    id,
    category: definition.category,
    kind,
    label: definition.label,
    flag: definition.flag ?? null,
    ...(position ? { position } : {}),
  };
  return { model: { ...model, nodes: [...model.nodes, node], topology: "manual" }, id };
}

/** Connect two nodes. Rejects self-links and duplicates. Marks topology manual. */
export function connectNodes(model: InfraModel, source: string, target: string): InfraModel {
  if (source === target) return model;
  const ids = new Set(model.nodes.map((n) => n.id));
  if (!ids.has(source) || !ids.has(target)) return model;
  if (model.edges.some((e) => e.source === source && e.target === target)) {
    return { ...model, topology: "manual" };
  }
  const edge: ModelEdge = { id: `${source}->${target}`, source, target, origin: "user" };
  return { ...model, edges: [...model.edges, edge], topology: "manual" };
}

/** Remove nodes and every edge touching them. Marks topology manual. */
export function removeNodes(model: InfraModel, ids: string[]): InfraModel {
  const gone = new Set(ids);
  if (gone.size === 0) return model;
  return {
    ...model,
    nodes: model.nodes.filter((n) => !gone.has(n.id)),
    edges: model.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
    topology: "manual",
  };
}

/** Remove edges by id. Marks topology manual so they do not come straight back. */
export function removeEdges(model: InfraModel, ids: string[]): InfraModel {
  const gone = new Set(ids);
  if (gone.size === 0) return model;
  return {
    ...model,
    edges: model.edges.filter((e) => !gone.has(e.id)),
    topology: "manual",
  };
}
