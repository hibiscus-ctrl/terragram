// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { EngineKind } from "./engine.ts";
import { ENGINE_VERSION } from "./evidence.ts";
import { explainModel } from "./explain.ts";
import { assessFeasibility } from "./feasibility.ts";
import type { ManagedModelId } from "./managed-models.ts";
import { type Cloud, type InfraModel, resourceNodes } from "./model.ts";
import type { Signer } from "./ports.ts";
import {
  contentHashFor,
  type EvidenceReceipt,
  planText,
  RECEIPT_SCHEMA,
  receiptJson,
  type SbomEntry,
} from "./receipt.ts";
import {
  emitTerraform,
  type TerraformFile,
  type TerraformOutput,
  type TerraformTool,
} from "./terraform.ts";

/**
 * The signed evidence receipt Terragram emits when a reviewer confirms the gate.
 *
 * The `content_hash` is a real SHA-256 over the canonical model plus the generated
 * plan; `signature` is a detached Ed25519 signature over that hash, present only
 * when the host passes a `Signer` — otherwise the receipt ships unsigned rather than
 * claiming a signature it does not have.
 *
 * Two things make the receipt checkable by someone who does not trust us. The public
 * key travels with it, so verification needs no call home. And the plan is re-emitted
 * here from (model, cloud) rather than accepted from the client, so the thing that
 * was hashed is the thing this server would build.
 *
 * Loading the key, and deciding whether one is configured at all, is the host's job:
 * the engine only ever sees a `Signer`.
 */

const PLAN_ORDER = ["main.tf", "variables.tf", "outputs.tf"];

/** Hash order: the three plan files, then anything the emitter wrote beside them
 *  (a function's handler stub), sorted. Recorded in the receipt so a verifier
 *  hashes exactly what was signed — a file in the bundle but not in the hash
 *  would be a file nobody vouched for. */
function planOrder(files: TerraformFile[]): string[] {
  const rest = files.map((f) => f.name).filter((n) => !PLAN_ORDER.includes(n)).sort();
  return [...PLAN_ORDER, ...rest];
}

export async function buildEvidenceReceipt(
  model: InfraModel,
  cloud: Cloud,
  engine: EngineKind,
  approver: string,
  nowIso: string,
  options: {
    tool?: TerraformTool;
    explanation?: string;
    /** The model the managed turn ran on, recorded as the receipt's provenance. Ignored
     *  (the field is null) for the deterministic engine. */
    inferenceModel?: ManagedModelId | null;
    /** Null or absent ships the receipt unsigned. */
    signer?: Signer | null;
    /** The runtime the engine executed on, recorded in provenance (`process.version`). */
    nodeVersion: string;
  },
): Promise<{
  receipt: EvidenceReceipt;
  terraform: TerraformOutput;
  /** Present only when a signer is configured: the detached signature over
   *  `receipt.json`'s exact bytes and the public half in the PEM form
   *  `infraweaver verify-evidence` takes. */
  attestation: { detachedSignature: string; publicKeyPem: string } | null;
}> {
  const tool = options.tool ?? "terraform";
  const terraform = emitTerraform(model, cloud, tool);
  const order = planOrder(terraform.files);
  const contentHash = await contentHashFor({
    model,
    cloud,
    planText: planText(terraform.files, order),
  });

  const sbom: SbomEntry[] = [
    { name: "terragram-engine", version: ENGINE_VERSION },
    { name: terraform.provider, version: terraform.providerVersion },
    ...terraform.modules.map((m) => ({ name: m.source, version: m.version })),
  ];
  const { omitted } = assessFeasibility(model, cloud);

  const signer = options.signer ?? null;
  const signature = signer ? signer.sign(contentHash) : null;

  const receipt: EvidenceReceipt = {
    schema: RECEIPT_SCHEMA,
    contentHash,
    signed: signature !== null,
    keyId: signer?.keyId ?? null,
    signedAt: signer?.signedAt ?? null,
    signature,
    publicKey: signer?.publicKey ?? null,
    approver,
    approvedAt: nowIso,
    cloud,
    region: terraform.region,
    regionLabel: terraform.regionLabel,
    tool,
    engine,
    resourceCount: resourceNodes(model).length,
    sbom,
    omitted,
    explanation: options.explanation ?? explainModel(model, cloud, terraform.regionLabel),
    plan: order,
    provenance: {
      // Null for the deterministic engine, and that is the truthful answer: no
      // model chose anything, the kind registry did.
      //
      // For a managed one, the model the TURN ran on, passed down from the compose
      // that produced this plan. Re-resolving it here instead would read today's
      // configuration, which stopped being the same answer the moment users could
      // choose a model: pick Opus, approve, and a receipt built from config would
      // name Sonnet. A receipt whose whole claim is "this model produced this plan"
      // cannot be the field that guesses.
      model: engine === "managed" ? (options.inferenceModel ?? null) : null,
      node: options.nodeVersion,
      scanners: [],
    },
  };

  // Signed last, because it covers the finished receipt rather than a field of it.
  const attestation = signer
    ? { detachedSignature: signer.sign(receiptJson(receipt)), publicKeyPem: signer.publicKeyPem }
    : null;

  return { receipt, terraform, attestation };
}
