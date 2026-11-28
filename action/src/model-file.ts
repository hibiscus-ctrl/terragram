// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { attributeProblems } from "terragram-engine/kinds";
import { type Cloud, type InfraModel, modelDocumentSchema, resourceNodes } from "terragram-engine/model";

/** The cloud a model targets when its file does not say: the CLI's default. */
const DEFAULT_CLOUD: Cloud = "azure";

export type ModelDocument = { model: InfraModel; cloud: Cloud };

/**
 * Read a model file (`schemas/model.v1.schema.json`): JSON, then the engine's own schema.
 * Returns the problem as text instead of throwing, because the caller treats a bad base
 * version (shown as "unavailable") differently from a bad head version (a failed step).
 */
export function parseModelDocument(text: string): { ok: true; document: ModelDocument } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "it is not valid JSON" };
  }
  const parsed = modelDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `  ${issue.path.join(".") || "(document)"}: ${issue.message}`)
      .join("\n");
    return { ok: false, problem: `it is not a diagram model:\n${issues}` };
  }
  const { nodes, edges, topology, cloud } = parsed.data;
  // Two edges between the same two nodes would be read as one, the last: the model must say which it means.
  const seen = new Map<string, number>();
  for (const [index, edge] of edges.entries()) {
    const key = `${edge.source}\u0000${edge.target}`;
    const first = seen.get(key);
    if (first !== undefined) return { ok: false, problem: `it draws two edges between the same two nodes: edges ${first + 1} and ${index + 1} join the same two nodes` };
    seen.set(key, index);
  }
  const problems = attributeProblems(resourceNodes({ nodes, edges, topology }), cloud ?? DEFAULT_CLOUD);
  if (problems.length > 0) return { ok: false, problem: `it has values that cannot be used:\n${problems.map((p) => `  ${p}`).join("\n")}` };
  return { ok: true, document: { model: { nodes, edges, topology }, cloud: cloud ?? DEFAULT_CLOUD } };
}
