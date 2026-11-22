// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The internal model — the single auditable representation every mode flows
 * through. Chat, diagram and Terraform are three projections of this one shape,
 * so the three never drift. Phase 4 ships a deterministic stub behind this
 * boundary; Phase 5 swaps in the real translation engine without the UI changing.
 */

const NODE_CATEGORIES = [
  "compute",
  "network",
  "storage",
  "identity",
  "observability",
  "edge",
] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export const CLOUDS = ["azure", "aws"] as const;
export type Cloud = (typeof CLOUDS)[number];

/** A low-confidence attribute the model surfaces at the review gate. */
const reviewFlagSchema = z.object({
  reason: z.string().max(400),
});
export type ReviewFlag = z.infer<typeof reviewFlagSchema>;

const modelNodeSchema = z.object({
  id: z.string().min(1).max(80),
  category: z.enum(NODE_CATEGORIES),
  /** The semantic resource kind — drives Terraform emission (e.g. "redis-cache"). */
  kind: z.string().min(1).max(80),
  label: z.string().max(160),
  /** Present when the model wasn't confident about an attribute. */
  flag: reviewFlagSchema.nullable().default(null),
  /** Reviewer-confirmed attribute choices (e.g. `{ "Compute tier": "Production (P3v3)" }`),
   *  set in the node inspector. Keys come from the fixed inspector field set, so the
   *  bounds here are a hostile-payload guard, not a UX limit. */
  attributes: z.record(z.string().max(40), z.string().max(120)).optional(),
  /** Canvas coordinates, once the node has been placed. Nodes without one are laid
   *  out by dagre; nodes with one keep where the user dragged them, so the mental
   *  map survives a turn. */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type ModelNode = z.infer<typeof modelNodeSchema>;

/** Who created an edge. `derived` edges are regenerated from the spine rules each
 *  turn; `user` edges are the reviewer's own topology and are never regenerated. */
const EDGE_ORIGINS = ["derived", "user"] as const;

const modelEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  origin: z.enum(EDGE_ORIGINS).default("derived"),
});
export type ModelEdge = z.infer<typeof modelEdgeSchema>;

/** Bounds sized generously above anything the engine emits — they exist so a
 *  hostile request body can't smuggle a multi-megabyte "model" into the inference
 *  prompt (token cost) or the snapshot store. */
export const infraModelSchema = z.object({
  nodes: z.array(modelNodeSchema).max(300),
  edges: z.array(modelEdgeSchema).max(600),
  /** `manual` once the reviewer has drawn or deleted a connection themselves. From
   *  then on chat turns may add nodes and edges but never re-derive the topology,
   *  so a hand-built diagram is not silently rewritten. */
  topology: z.enum(["derived", "manual"]).default("derived"),
});
export type InfraModel = z.infer<typeof infraModelSchema>;

/** The id a model document carries in its `schema` field, and the name of its JSON
 *  Schema (`schemas/model.v1.schema.json`). */
export const MODEL_SCHEMA = "terragram.model/v1" as const;

/**
 * The model as a standalone JSON document: what `terragram parse` writes and
 * `terragram generate` reads back. It is `infraModelSchema` plus two optional
 * envelope fields, so a bare model (the `model.json` in an evidence bundle, which
 * the content hash covers) is a valid document too. The target cloud rides along
 * because a model alone does not say which cloud it is for.
 */
export const modelDocumentSchema = infraModelSchema.extend({
  schema: z.literal(MODEL_SCHEMA).optional(),
  cloud: z.enum(CLOUDS).optional(),
});

export const EMPTY_MODEL: InfraModel = { nodes: [], edges: [], topology: "derived" };

/** Category presentation — colours match the node-category legend in globals.css. */
export const CATEGORY_META: Record<
  NodeCategory,
  { label: string; color: string; text: string; bg: string; border: string }
> = {
  compute: {
    label: "Compute",
    color: "#047857",
    text: "text-cat-compute",
    bg: "bg-cat-compute-bg",
    border: "border-cat-compute",
  },
  network: {
    label: "Network",
    color: "#2563eb",
    text: "text-cat-network",
    bg: "bg-cat-network-bg",
    border: "border-cat-network",
  },
  storage: {
    label: "Storage",
    color: "#7c3aed",
    text: "text-cat-storage",
    bg: "bg-cat-storage-bg",
    border: "border-cat-storage",
  },
  identity: {
    label: "Identity",
    color: "#b45309",
    text: "text-cat-security",
    bg: "bg-cat-security-bg",
    border: "border-cat-security",
  },
  observability: {
    label: "Observability",
    color: "#0e7490",
    text: "text-cat-observability",
    bg: "bg-cat-observability-bg",
    border: "border-cat-observability",
  },
  edge: {
    label: "Edge",
    color: "#665e4f",
    text: "text-cat-neutral",
    bg: "bg-cat-neutral-bg",
    border: "border-cat-neutral",
  },
};

/** Nodes the model treats as conceptual (the public internet, a user) — shown on
 *  the diagram to orient the reader, but never emitted as a cloud resource. */
function isConceptual(node: ModelNode): boolean {
  return node.category === "edge";
}

export function countFlags(model: InfraModel): number {
  return model.nodes.filter((n) => n.flag).length;
}

export function resourceNodes(model: InfraModel): ModelNode[] {
  return model.nodes.filter((n) => !isConceptual(n));
}
