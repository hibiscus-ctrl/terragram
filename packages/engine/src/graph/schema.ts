// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * infraharvest's `graph/v1` document: the resources an import took over, the module
 * calls they sit in, and the references between them. Names, paths, attributes and
 * values are not in it, which is why a diagram of it can be shared.
 *
 * This mirrors `schemas/vendor/infraharvest/graph-v1.schema.json` (Apache-2.0, vendored
 * unchanged); `tests/graph.test.ts` checks that both accept and refuse the same
 * documents. It adds the one thing a JSON Schema cannot say: an edge or a parent is
 * an index into `nodes`, so it must point at one, and a parent must be a module call.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const timestamp = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
const index = z.number().int().min(0);
const text = z.string().min(1);

const graphNodeSchema = z
  .strictObject({
    kind: z.enum(["resource", "module"]),
    type: text.optional(),
    id: text.optional(),
    account: text,
    region: text.optional(),
    /** The environment of the node's root, when the import named its environments. */
    environment: text.optional(),
    /** A resource's address, as `redaction.addresses` says it was kept. */
    address: text.optional(),
    /** A module call's address (`module.<name>`), likewise. */
    module_address: text.optional(),
    /** The root the node was generated in, as a path in the output directory, likewise (hashed, or left out, as the addresses are). */
    root: text.optional(),
    source: text.optional(),
    version: text.optional(),
    parent: index.optional(),
  })
  .superRefine((node, ctx) => {
    const present = (...keys: (keyof typeof node)[]) => keys.filter((key) => node[key] !== undefined);
    const need = (...keys: (keyof typeof node)[]) => {
      for (const key of keys) {
        if (node[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `a ${node.kind} needs "${key}"` });
      }
    };
    const refuse = (...keys: (keyof typeof node)[]) => {
      for (const key of present(...keys)) {
        ctx.addIssue({ code: "custom", path: [key], message: `a ${node.kind} has no "${key}"` });
      }
    };
    if (node.kind === "resource") {
      need("type", "id");
      refuse("source", "version", "module_address");
    } else {
      need("source");
      refuse("type", "id", "parent", "address");
    }
  });

const graphEdgeSchema = z.strictObject({ from: index, to: index });

export const graphDocumentSchema = z
  .strictObject({
    schema: z.literal("infraharvest/graph/v1"),
    run_id: uuid,
    generated_at: timestamp,
    tool: z.strictObject({ name: text, version: text }),
    cloud: z.enum(["aws", "azure", "google"]),
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
    redaction: z.strictObject({
      ids_hashed: z.boolean(),
      hash_alg: z.literal("hmac-sha256"),
      /** How the addresses were written: as they are, hashed, or not at all. */
      addresses: z.enum(["plain", "hashed", "dropped"]).optional(),
    }),
  })
  .superRefine((doc, ctx) => {
    doc.edges.forEach((edge, i) => {
      for (const end of ["from", "to"] as const) {
        if (edge[end] >= doc.nodes.length) {
          ctx.addIssue({ code: "custom", path: ["edges", i, end], message: `no node ${edge[end]}` });
        }
      }
    });
    doc.nodes.forEach((node, i) => {
      if (node.parent === undefined) return;
      if (doc.nodes[node.parent]?.kind !== "module") {
        ctx.addIssue({ code: "custom", path: ["nodes", i, "parent"], message: `node ${node.parent} is not a module call` });
      }
    });
  });

export type GraphDocument = z.infer<typeof graphDocumentSchema>;

/** The document is not a valid `graph/v1`: the message names where, and what is wrong. */
export class GraphDocumentError extends Error {
  override name = "GraphDocumentError";
}

/** The first few problems of a failed parse, one per line, as `path: message`. */
export function describeIssues(error: z.ZodError, limit = 5): string {
  const lines = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(document)";
    return `${path}: ${issue.message}`;
  });
  if (error.issues.length > limit) lines.push(`... and ${error.issues.length - limit} more`);
  return lines.join("\n");
}

/**
 * Read a `graph/v1` document from JSON text or an already-parsed value.
 * Throws {@link GraphDocumentError} when it is not valid JSON or not a `graph/v1`.
 */
export function parseGraphDocument(input: unknown): GraphDocument {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new GraphDocumentError("the graph document is not valid JSON");
    }
  }
  const parsed = graphDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new GraphDocumentError(`not an infraharvest graph/v1 document:\n${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}
