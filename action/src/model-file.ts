// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type Cloud, type InfraModel, modelDocumentSchema } from "terragram-engine/model";

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
    return { ok: false, problem: `it is not a Terragram model:\n${issues}` };
  }
  const { nodes, edges, topology, cloud } = parsed.data;
  return { ok: true, document: { model: { nodes, edges, topology }, cloud: cloud ?? DEFAULT_CLOUD } };
}
