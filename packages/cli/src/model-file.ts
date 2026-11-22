// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type Cloud, CLOUDS, type InfraModel, MODEL_SCHEMA, modelDocumentSchema } from "terragram-engine/model";

import { CommandError, type Io, readText, UsageError } from "./io.ts";

/** The cloud a command targets when nothing says otherwise: the app's own default. */
export const DEFAULT_CLOUD: Cloud = "azure";

export function parseCloud(value: string | undefined): Cloud | undefined {
  if (value === undefined) return undefined;
  const cloud = CLOUDS.find((c) => c === value);
  if (!cloud) throw new UsageError(`--cloud must be one of ${CLOUDS.join(", ")} (got "${value}")`);
  return cloud;
}

/** A model.json: the model, with the schema id and the cloud it was written for. */
export function modelDocument(model: InfraModel, cloud: Cloud): string {
  return `${JSON.stringify({ schema: MODEL_SCHEMA, cloud, ...model }, null, 2)}\n`;
}

/** Read and validate a model document (`schemas/model.v1.schema.json`). */
export function readModel(io: Io, path: string): { model: InfraModel; cloud: Cloud | undefined } {
  const text = readText(io, path);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CommandError(`${path} is not valid JSON`);
  }
  const parsed = modelDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `  ${issue.path.join(".") || "(document)"}: ${issue.message}`)
      .join("\n");
    throw new CommandError(`${path} is not a Terragram model:\n${issues}`);
  }
  const { nodes, edges, topology, cloud } = parsed.data;
  return { model: { nodes, edges, topology }, cloud };
}
