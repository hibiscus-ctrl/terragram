// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The internal model — the single auditable representation every mode flows
 * through. Chat, diagram and Terraform are three projections of this one shape,
 * so the three never drift. The translators (deterministic and managed) sit behind this
 * boundary and can change without the model changing.
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

/** Every cloud a model can describe. */
export const CLOUDS = ["azure", "aws", "gcp"] as const;
export type Cloud = (typeof CLOUDS)[number];

/** The clouds Terragram writes Terraform for: what `generate`, a brief and a picture can target. */
export const GENERATED_CLOUDS = ["azure", "aws", "gcp"] as const;
export type GeneratedCloud = (typeof GENERATED_CLOUDS)[number];

/** The schemas' words for a document's `cloud`: `gcp` joined the enum inside `diagram.model/v1` and `diagram.receipt/v3`. */
export const CLOUD_DESCRIPTION =
  "The cloud the document describes: `azure`, `aws` or `gcp` (Google Cloud). A reader that validates this field against a closed list must accept `gcp`; documents for `azure` and `aws` are unchanged.";

/** A low-confidence attribute the model surfaces at the review gate. */
const reviewFlagSchema = z.object({
  reason: z.string().max(400),
});
export type ReviewFlag = z.infer<typeof reviewFlagSchema>;

/** The levels a node's access to itself is recorded at: only the ones that are a path to widen its own access. */
const SELF_ACCESS = ["admin", "unscoped"] as const;
export type SelfAccess = (typeof SELF_ACCESS)[number];

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
  /** Set when the node's own grants reach the node itself (a role whose policy may rewrite the role, a service account that may mint tokens for itself): a path to widen its own access. `admin`, or `unscoped` when the grant could not be read closely. Absent otherwise; lower levels on oneself are not recorded. Counts as admin access wherever access is shown. */
  selfAccess: z.enum(SELF_ACCESS).optional().describe("Set when the node's own grants reach the node itself, so it can widen its own access (a role whose policy may rewrite the role, a service account that may mint tokens for itself): admin, or unscoped when the grant could not be read closely. Absent otherwise. Counts as admin access."),
  /** With `selfAccess`: every grant behind it carries a Condition. The level is the same. */
  selfConditional: z.boolean().optional().describe("With selfAccess: every grant behind it carries a condition. The level is the same."),
  /** With `selfConditional`: some grant gives this level on itself with no condition at all. Always below `selfAccess`, so only `admin` under `unscoped`. */
  selfUnconditional: z.enum(SELF_ACCESS).optional().describe("With selfConditional: the strongest level some grant gives the node over itself with no condition at all, below selfAccess. Absent otherwise."),
});
export type ModelNode = z.infer<typeof modelNodeSchema>;

/** Who created an edge. `derived` edges are regenerated from the spine rules each
 *  turn; `user` edges are the reviewer's own topology and are never regenerated. */
const EDGE_ORIGINS = ["derived", "user"] as const;

/**
 * What an edge means for access, when the Terraform it was read from says so. `runs-as`
 * joins a workload to the role or managed identity it runs under; the others join an
 * identity to a resource its policy names, by the strongest level the policy grants
 * there. `unscoped` is a grant that is not bounded to a drawn resource: a wildcard
 * resource, a policy that cannot be read, a role assigned over a whole subscription. An
 * edge with no access type is a plain connection. `conditional` marks a typed edge whose
 * grant is behind a condition; the type is what the grant would allow, never narrowed.
 * `unconditional` is, on a conditional edge, the strongest level some grant gives with no
 * condition at all.
 */
const EDGE_ACCESS = ["runs-as", "read", "write", "admin", "unscoped"] as const;
export type EdgeAccess = (typeof EDGE_ACCESS)[number];

/** How each access type is worded and coloured wherever an edge is drawn. `unscoped` and `admin`
 *  share a colour; the wording (and `dash`, where the renderer draws one) tells them apart. */
export const EDGE_ACCESS_META: Record<EdgeAccess, { label: string; phrase: string; color: string; dash?: string }> = {
  "runs-as": { label: "runs as", phrase: "runs as", color: "#665e4f", dash: "4 3" },
  read: { label: "read", phrase: "can read", color: "#2563eb" },
  write: { label: "write", phrase: "can write to", color: "#b45309" },
  admin: { label: "admin", phrase: "has admin access to", color: "#b91c1c" },
  unscoped: { label: "unscoped", phrase: "has unscoped access to", color: "#b91c1c", dash: "6 3" },
};

/** The word an edge's access type is drawn with: the type, "conditional" when its grant is behind a condition, and the level some grant gives without one. Fixed wording, never text from the file. */
export function edgeAccessLabel(edge: { access: EdgeAccess; conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined }): string {
  const label = EDGE_ACCESS_META[edge.access].label;
  if (!edge.conditional) return label;
  return edge.unconditional ? `${label}, conditional (${EDGE_ACCESS_META[edge.unconditional].label} unconditional)` : `${label}, conditional`;
}

/** What a node's access to itself is called wherever it is shown: fixed wording, never text from the file. Undefined when the node has none. */
export function selfAccessPhrase(node: { selfAccess?: SelfAccess | undefined; selfConditional?: boolean | undefined; selfUnconditional?: SelfAccess | undefined }): string | undefined {
  if (!node.selfAccess) return undefined;
  if (!node.selfConditional) return `has ${node.selfAccess} access to itself`;
  return `has ${node.selfAccess} access to itself (conditional${node.selfUnconditional ? `; ${node.selfUnconditional} without the condition` : ""})`;
}

/** A node's access to itself worded like an edge's access type ("admin, conditional (admin unconditional)"). Undefined when it has none. */
export function selfAccessLabel(node: { selfAccess?: SelfAccess | undefined; selfConditional?: boolean | undefined; selfUnconditional?: SelfAccess | undefined }): string | undefined {
  if (!node.selfAccess) return undefined;
  return edgeAccessLabel({ access: node.selfAccess, conditional: node.selfConditional, unconditional: node.selfUnconditional });
}

/** The most edges a model holds. */
export const MAX_MODEL_EDGES = 600;

const modelEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  origin: z.enum(EDGE_ORIGINS).default("derived"),
  access: z.enum(EDGE_ACCESS).optional(),
  /** Set (to true) when every grant behind a typed edge carries a condition. Absent otherwise. */
  conditional: z.boolean().optional(),
  /** On a conditional edge: the strongest level some grant gives with no condition at all, below `access`. Absent otherwise. */
  unconditional: z.enum(EDGE_ACCESS).optional(),
});
export type ModelEdge = z.infer<typeof modelEdgeSchema>;

/** Bounds sized generously above anything the engine emits — they exist so a
 *  hostile request body can't smuggle a multi-megabyte "model" into the inference
 *  prompt (token cost) or the snapshot store. */
export const infraModelSchema = z.object({
  nodes: z.array(modelNodeSchema).max(300),
  edges: z.array(modelEdgeSchema).max(MAX_MODEL_EDGES),
  /** `manual` once the reviewer has drawn or deleted a connection themselves. From
   *  then on chat turns may add nodes and edges but never re-derive the topology,
   *  so a hand-built diagram is not silently rewritten. */
  topology: z.enum(["derived", "manual"]).default("derived"),
});
export type InfraModel = z.infer<typeof infraModelSchema>;

/** The id a model document carries in its `schema` field, and the name of its JSON
 *  Schema (`schemas/model.v1.schema.json`). */
export const MODEL_SCHEMA = "diagram.model/v1" as const;

/**
 * The model as a standalone JSON document: what `terragram parse` writes and
 * `terragram generate` reads back. It is `infraModelSchema` plus two optional
 * envelope fields, so a bare model (the `model.json` in an evidence bundle, which
 * the content hash covers) is a valid document too. The target cloud rides along
 * because a model alone does not say which cloud it is for.
 */
export const modelDocumentSchema = infraModelSchema.extend({
  schema: z.literal(MODEL_SCHEMA).optional(),
  cloud: z
    .enum(CLOUDS)
    .describe(CLOUD_DESCRIPTION)
    .optional(),
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
