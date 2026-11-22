// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { generateKeyPairSync, sign } from "node:crypto";

import { buildEvidenceReceipt as buildReceipt } from "terragram-engine/build-receipt";
import type { EngineKind } from "terragram-engine/engine";
import { DEFAULT_MANAGED_MODEL, type ManagedModelId } from "terragram-engine/managed-models";
import type { Cloud, InfraModel } from "terragram-engine/model";
import type { Signer } from "terragram-engine/ports";
import type { TerraformTool } from "terragram-engine/terraform";

/** A signer over a fresh Ed25519 key, in the shape a host hands the engine. */
export function testSigner(keyId = "test-key", signedAt = "2026-09-11T00:00:00Z"): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    keyId,
    signedAt,
    publicKey: der.toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (bytes) => sign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64"),
  };
}

/**
 * The engine's receipt builder with the host-supplied fields filled the way the CLI
 * fills them: the running Node version, no signature unless a signer is passed, and the
 * default managed model recorded for a managed turn that names none.
 */
export function buildEvidenceReceipt(
  model: InfraModel,
  cloud: Cloud,
  engine: EngineKind,
  approver: string,
  nowIso: string,
  options: {
    tool?: TerraformTool;
    explanation?: string;
    inferenceModel?: ManagedModelId;
    signer?: Signer;
  } = {},
) {
  return buildReceipt(model, cloud, engine, approver, nowIso, {
    ...(options.tool ? { tool: options.tool } : {}),
    ...(options.explanation !== undefined ? { explanation: options.explanation } : {}),
    inferenceModel: engine === "managed" ? (options.inferenceModel ?? DEFAULT_MANAGED_MODEL) : null,
    signer: options.signer ?? null,
    nodeVersion: process.version,
  });
}
