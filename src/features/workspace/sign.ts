import { createPublicKey } from "node:crypto";

import { loadSigningKey, signBytes, type SigningKey } from "@infraweaver-io/attest/signing";

import { evidenceSignerFromEnv } from "@/features/api/evidence";

import { ENGINE_VERSION } from "./evidence.ts";
import type { EngineKind } from "./engine.ts";
import { resolvedModel } from "./inference.ts";
import type { ManagedModelId } from "./managed-models.ts";
import { explainModel } from "./explain.ts";
import { assessFeasibility } from "./feasibility.ts";
import { type Cloud, type InfraModel, resourceNodes } from "./model.ts";
import {
  contentHashFor,
  type EvidenceReceipt,
  planText,
  RECEIPT_SCHEMA,
  receiptJson,
  type SbomEntry,
} from "./receipt.ts";
import { emitTerraform, type TerraformFile, type TerraformOutput, type TerraformTool } from "./terraform.ts";

export type { EvidenceReceipt } from "./receipt.ts";

/**
 * The signed evidence receipt Terragram emits when a reviewer confirms the gate.
 *
 * The `content_hash` is a real SHA-256 over the canonical model plus the generated
 * plan; `signature` is a detached Ed25519 signature over that hash, present only
 * when a key is configured — otherwise the receipt ships unsigned rather than
 * claiming a signature it does not have.
 *
 * Two things make the receipt checkable by someone who does not trust us. The public
 * key travels with it, so verification needs no call home. And the plan is re-emitted
 * here from (model, cloud) rather than accepted from the client, so the thing that
 * was hashed is the thing this server would build.
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

export async function buildEvidenceReceipt(
  model: InfraModel,
  cloud: Cloud,
  engine: EngineKind,
  approver: string,
  nowIso: string,
  options: { tool?: TerraformTool; explanation?: string; inferenceModel?: ManagedModelId } = {},
): Promise<{
  receipt: EvidenceReceipt;
  terraform: TerraformOutput;
  /** Present only when a key is configured: the detached signature over
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

  const signer = evidenceSignerFromEnv(nowIso);
  let signature: string | null = null;
  let keyId: string | null = null;
  let signedAt: string | null = null;
  let publicKey: string | null = null;
  let key: SigningKey | null = null;

  if (signer && typeof signer.privateKey === "string") {
    // A misconfigured key fails loudly rather than silently shipping an unsigned
    // receipt while the UI claims it was signed.
    key = loadEvidenceKey(signer.privateKey);
    if (key) {
      signature = signBytes(contentHash, key);
      keyId = signer.keyId;
      signedAt = signer.signedAt;
      publicKey = publicKeyDer(key);
    }
  }

  const receipt: EvidenceReceipt = {
    schema: RECEIPT_SCHEMA,
    contentHash,
    signed: signature !== null,
    keyId,
    signedAt,
    signature,
    publicKey,
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
      model: engine === "managed" ? (options.inferenceModel ?? resolvedModel()) : null,
      node: process.version,
      scanners: [],
    },
  };

  // Signed last, because it covers the finished receipt rather than a field of it.
  const attestation = key
    ? { detachedSignature: signBytes(receiptJson(receipt), key), publicKeyPem: key.publicKeyPem }
    : null;

  return { receipt, terraform, attestation };
}
