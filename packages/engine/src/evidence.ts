// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { EngineKind } from "./engine.ts";
import type { Cloud, InfraModel } from "./model.ts";
import { resourceNodes } from "./model.ts";
import type { TerraformOutput } from "./terraform.ts";

/**
 * The evidence *summary* for a model as it changes — a cheap, synchronous preview.
 * The authoritative, cryptographically-hashed and (when a signer is passed)
 * Ed25519-signed receipt is `buildEvidenceReceipt` in `build-receipt.ts`. This preview never claims
 * a signature it doesn't have; it reports the resource set, provider SBOM, region,
 * and which translator answered.
 */

/** How receipts and previews name the engine in their SBOM: by what it does, like the
 *  `diagram.*` schema ids, so the name holds wherever the engine is built in. */
export const ENGINE_NAME = "diagram-engine";
export const ENGINE_VERSION = "0.1.0";

export type { EngineKind };

type SbomEntry = { name: string; version: string };

export type EvidenceBundle = {
  resourceCount: number;
  cloud: Cloud;
  region: string;
  /** Honest label of the translator that produced the current model. */
  inferenceMode: string;
  sbom: SbomEntry[];
  /** Short, non-cryptographic preview id over the model + plan (the signed
   *  SHA-256 content hash is computed server-side in the receipt). */
  previewId: string;
};

/** FNV-1a — a small, dependency-free, deterministic digest for the live preview id
 *  only. NOT the signed content hash (that is SHA-256, computed in `sign.ts`). */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonical(model: InfraModel): string {
  const nodes = [...model.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `${n.id}:${n.category}:${n.kind}`)
    .join("|");
  const edges = [...model.edges].map((e) => e.id).sort().join("|");
  return `${nodes}#${edges}`;
}

function inferenceModeLabel(engine: EngineKind): string {
  return engine === "managed" ? "Managed · UK Bedrock" : "Deterministic · local";
}

export function buildEvidence(
  model: InfraModel,
  cloud: Cloud,
  terraform: TerraformOutput,
  engine: EngineKind,
): EvidenceBundle {
  const planText = terraform.files.map((f) => f.content).join("\n");
  const previewId = fnv1a(`${canonical(model)}::${cloud}::${planText}`);

  const providerVersion = terraform.files[0]?.content.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? "~> 0";

  return {
    resourceCount: resourceNodes(model).length,
    cloud,
    region: terraform.regionLabel,
    inferenceMode: inferenceModeLabel(engine),
    sbom: [
      { name: ENGINE_NAME, version: ENGINE_VERSION },
      { name: terraform.provider, version: providerVersion },
      ...terraform.modules.map((m) => ({ name: m.source, version: m.version })),
    ],
    previewId,
  };
}
