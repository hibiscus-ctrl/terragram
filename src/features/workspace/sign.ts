// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createPublicKey } from "node:crypto";

import { loadSigningKey, signBytes, type SigningKey } from "@infraweaver-io/attest/signing";
import { buildEvidenceReceipt as buildReceipt } from "terragram-engine/build-receipt";
import type { EngineKind } from "terragram-engine/engine";
import type { ManagedModelId } from "terragram-engine/managed-models";
import type { Cloud, InfraModel } from "terragram-engine/model";
import type { Signer } from "terragram-engine/ports";
import type { TerraformTool } from "terragram-engine/terraform";

import { evidenceSignerFromEnv } from "@/features/api/evidence";

import { resolvedModel } from "./inference.ts";

/**
 * The signing half of the evidence receipt. The engine builds the receipt
 * (`terragram-engine/build-receipt`) and signs it through a `Signer`; this file is the
 * host binding that reads `EVIDENCE_SIGNING_KEY` from the environment, loads the key
 * and hands the engine a `Signer` over it — or nothing, when no key is configured, and
 * the receipt then ships unsigned rather than claiming a signature it does not have.
 */

/**
 * Load the configured signing key through `@infraweaver-io/attest` — the same
 * Ed25519 primitives Infraweaver signs its evidence with.
 *
 * It buys two things over the hand-rolled `node:crypto` calls this replaced.
 * It REFUSES a key that is present but not a valid Ed25519 PKCS#8 key, instead
 * of discovering that at signing time; and it always derives the public half, so
 * a receipt can no longer be marked `signed: true` while carrying
 * `publicKey: null` — a bundle that claims a signature nobody can check is
 * exactly the artefact this product exists to not produce.
 *
 * `EVIDENCE_SIGNING_KEY` has always been a raw PEM here while `loadSigningKey`
 * takes it base64-encoded, so both spellings are accepted rather than breaking
 * a deployment that already has the key set.
 */
function loadEvidenceKey(raw: string): SigningKey | null {
  const value = raw.trim();
  const encoded = value.includes("-----BEGIN") ? Buffer.from(value, "utf8").toString("base64") : value;
  return loadSigningKey(encoded, { envName: "EVIDENCE_SIGNING_KEY" });
}

/** Base64 SPKI DER of the public half — the form the browser verifier imports. */
function publicKeyDer(key: SigningKey): string {
  return createPublicKey(key.publicKeyPem).export({ type: "spki", format: "der" }).toString("base64");
}

/** The environment's signer, or null when no key is configured. A misconfigured key
 *  fails loudly rather than silently shipping an unsigned receipt while the UI claims
 *  it was signed. */
function signerFromEnv(nowIso: string): Signer | null {
  const configured = evidenceSignerFromEnv(nowIso);
  if (!configured || typeof configured.privateKey !== "string") return null;
  const key = loadEvidenceKey(configured.privateKey);
  if (!key) return null;
  return {
    keyId: configured.keyId,
    signedAt: configured.signedAt,
    publicKey: publicKeyDer(key),
    publicKeyPem: key.publicKeyPem,
    sign: (bytes) => signBytes(bytes, key),
  };
}

export async function buildEvidenceReceipt(
  model: InfraModel,
  cloud: Cloud,
  engine: EngineKind,
  approver: string,
  nowIso: string,
  options: { tool?: TerraformTool; explanation?: string; inferenceModel?: ManagedModelId } = {},
) {
  return buildReceipt(model, cloud, engine, approver, nowIso, {
    ...(options.tool ? { tool: options.tool } : {}),
    ...(options.explanation !== undefined ? { explanation: options.explanation } : {}),
    // The model the turn ran on; only a managed receipt without one falls back to today's
    // configuration, which is what the receipt did before the model became selectable.
    inferenceModel: engine === "managed" ? (options.inferenceModel ?? resolvedModel()) : null,
    signer: signerFromEnv(nowIso),
    nodeVersion: process.version,
  });
}
