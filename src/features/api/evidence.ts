// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createPrivateKey, type KeyObject, sign } from "node:crypto";

import { canonicalDigest } from "@infraweaver-io/core/contentHash";

/**
 * Auditor evidence export.
 *
 * The OSS engine emits the *indicative, backend-free* bundle; this is the
 * monetized layer: an **immutable, date-stamped** export whose `content_hash`
 * pins the exact evidence set, carrying the five-status verdict per control.
 * The builder is pure (the caller supplies `generatedAt` and the assembled
 * controls) so it is deterministic and unit-testable; hashing is over a
 * canonical (stable-key-ordered) serialization so the hash is reproducible.
 */

const EVIDENCE_SCHEMA = "terragram.evidence/v1";

type EvidenceVerdict =
  | "pass"
  | "fail"
  | "not-applicable"
  | "inconclusive"
  | "not-code-verifiable";

interface EvidenceItem {
  concern_id: string;
  source: string;
  rule_id: string;
  file: string | null;
  line: number | null;
  assessability: EvidenceVerdict;
}

interface EvidenceControl {
  id: string;
  name: string;
  verdict: EvidenceVerdict;
  statement?: string;
  remediation_pr?: number | null;
  evidence: EvidenceItem[];
}

export interface EvidenceBundleInput {
  org: string;
  residencyRegion: string;
  generatedAt: string;
  framework: { id: string; name: string; authority: string; revision: string };
  crosswalkVersion: string;
  repositories: string[];
  controls: EvidenceControl[];
}

/**
 * A detached signature over the bundle's `content_hash` (2b-ix). Non-repudiation:
 * an auditor can verify the bundle wasn't altered after Terragram produced it. The
 * `content_hash` is what's signed (not the whole body), so the signature stays
 * stable and verifiable independently of JSON formatting. Ed25519 keys are managed
 * out-of-band; for the published release artifact, Sigstore/cosign keyless signing
 * is the recommended path (see DEPLOY.md) — this in-band signature is the
 * always-available baseline when a key is configured.
 */
interface EvidenceSignature {
  algorithm: "ed25519";
  key_id: string;
  signature: string; // base64
  signed_at: string;
}

export interface EvidenceBundle extends Omit<EvidenceBundleInput, "generatedAt"> {
  schema: typeof EVIDENCE_SCHEMA;
  generated_at: string;
  summary: Record<EvidenceVerdict, number>;
  immutable: true;
  content_hash: string;
  /** Present only when an evidence signing key is configured. */
  signature?: EvidenceSignature;
}

export interface EvidenceSigner {
  /** PKCS#8 PEM Ed25519 private key (or a KeyObject). */
  privateKey: string | KeyObject;
  keyId: string;
  signedAt: string;
}

/**
 * Attach a detached Ed25519 signature over the bundle's `content_hash`. Pure +
 * deterministic given a fixed `signedAt`, so it's unit-testable; throws if the key
 * isn't a valid Ed25519 PKCS#8 key (a misconfigured signer should fail loudly, not
 * silently ship an unsigned bundle while claiming to sign).
 */
export function signEvidenceBundle(bundle: EvidenceBundle, signer: EvidenceSigner): EvidenceBundle {
  const key =
    typeof signer.privateKey === "string" ? createPrivateKey(signer.privateKey) : signer.privateKey;
  const signature = sign(null, Buffer.from(bundle.content_hash), key).toString("base64");
  return {
    ...bundle,
    signature: {
      algorithm: "ed25519",
      key_id: signer.keyId,
      signature,
      signed_at: signer.signedAt,
    },
  };
}

/**
 * Read the evidence signer from the environment (`EVIDENCE_SIGNING_KEY` = a PKCS#8
 * PEM Ed25519 private key, `EVIDENCE_SIGNING_KEY_ID` = its id). Returns null when
 * unconfigured — exports then ship unsigned (degrade-green) rather than failing.
 */
export function evidenceSignerFromEnv(signedAt: string): EvidenceSigner | null {
  const privateKey = process.env.EVIDENCE_SIGNING_KEY;
  if (!privateKey) return null;
  return {
    privateKey,
    keyId: process.env.EVIDENCE_SIGNING_KEY_ID ?? "evidence-signing-key",
    signedAt,
  };
}

function summarize(controls: EvidenceControl[]): Record<EvidenceVerdict, number> {
  const summary: Record<EvidenceVerdict, number> = {
    pass: 0,
    fail: 0,
    "not-applicable": 0,
    inconclusive: 0,
    "not-code-verifiable": 0,
  };
  for (const c of controls) summary[c.verdict] += 1;
  return summary;
}

export function buildEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  const body = {
    schema: EVIDENCE_SCHEMA as typeof EVIDENCE_SCHEMA,
    generated_at: input.generatedAt,
    org: input.org,
    residencyRegion: input.residencyRegion,
    framework: input.framework,
    crosswalkVersion: input.crosswalkVersion,
    repositories: input.repositories,
    controls: input.controls,
    summary: summarize(input.controls),
    immutable: true as const,
  };
  // `canonicalDigest` is @infraweaver-io/core's — the same key-sorted, depth-first
  // serialization Infraweaver Cloud hashes its evidence with. This file carried a
  // byte-identical copy; two implementations of "what was hashed" is the one thing
  // a verifier cannot survive disagreeing about.
  const content_hash = canonicalDigest(body);
  return { ...body, content_hash };
}
