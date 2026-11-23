// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { EngineKind } from "./engine.ts";
import { compareText } from "./graph/normalize.ts";
import type { Cloud, InfraModel } from "./model.ts";
import type { TerraformFile, TerraformTool } from "./terraform.ts";

/**
 * The evidence receipt and the bundle it travels in.
 *
 * Everything here is pure and runs in a browser as readily as in Node, which
 * is the whole point: the auditor has to be able to check the receipt without
 * calling us. The bundle therefore carries its own public key, and the content hash
 * is computed over a serialization defined in this one file, so the code that
 * verifies and the code that signs can never disagree about what was hashed.
 */

export const RECEIPT_SCHEMA = "diagram.receipt/v3" as const;

/** The schema id receipts carried until the content hash was made locale- and
 *  delimiter-safe. They are never written any more, but receipts already issued keep
 *  verifying, by the algorithm they were signed under. */
export const LEGACY_RECEIPT_SCHEMA = "diagram.receipt/v2" as const;

/** Schemas this build verifies, each by the hash its id names: `diagram.receipt/v3`
 *  by the canonical form below, `diagram.receipt/v2` by the original one. A caller
 *  holding receipts written under other ids (an older schema name) may pass those ids
 *  to `verifyBundle`, and they verify by the original hash, the only one that existed
 *  before v3. Any other id is refused. */
export const VERIFIABLE_RECEIPT_SCHEMAS: readonly string[] = [RECEIPT_SCHEMA, LEGACY_RECEIPT_SCHEMA];

/** The detached signature's filename inside the bundle, and the key beside it.
 *  Named by `@infraweaver-io/attest`'s convention: the signature covers the
 *  artefact's exact bytes and sits next to it. */
const RECEIPT_FILE = "receipt.json";
const RECEIPT_SIGNATURE_FILE = "receipt.json.sig";
const SIGNING_KEY_FILE = "signing-key.pem";

export type SbomEntry = { name: string; version: string };

/** Who produced the plan. Structurally the `@infraweaver-io/attest` envelope's
 *  `EvidenceProvenance` (a test pins the two together), declared here so the
 *  receipt's types, and the schema published for them, name no restricted package. */
export type ReceiptProvenance = {
  /** The model that chose the components, or null when none did. */
  model: string | null;
  /** The Node.js runtime the engine executed on (`process.version`). */
  node: string;
  /** Scanner tool versions observed while generating; empty when none ran. */
  scanners: { tool: string; version: string | null }[];
};

export type EvidenceReceipt = {
  schema: typeof RECEIPT_SCHEMA;
  contentHash: string;
  signed: boolean;
  keyId: string | null;
  signedAt: string | null;
  signature: string | null;
  /** Base64 SPKI of the signing key, so the bundle verifies with nothing else. */
  publicKey: string | null;
  approver: string;
  approvedAt: string;
  cloud: Cloud;
  region: string;
  regionLabel: string;
  tool: TerraformTool;
  engine: EngineKind;
  resourceCount: number;
  /** The engine, the provider, and every registry module the plan calls at its
   *  exact pinned version — code Terragram did not write is named, not implied. */
  sbom: SbomEntry[];
  /** Components on the diagram that generation left out because Terragram cannot
   *  build them on this cloud. Empty when the whole diagram was built. */
  omitted: string[];
  /** The plain-English description the approver was shown at the gate. */
  explanation: string;
  /** Plan file names, in the exact order they are hashed. */
  plan: string[];
  /**
   * WHO produced this: the model that chose the components, the runtime that ran
   * the emitter, and the scanners observed while doing it. The shape is
   * `@infraweaver-io/attest`'s, so one reader understands both products'
   * artefacts.
   *
   * `scanners` is deliberately empty here and that is the point of recording it.
   * Terragram scans nothing at generation time — the plan is checked by the emit
   * gate before release and by whatever the customer runs in their own pipeline
   * — and before this field a receipt had no way to SAY that. An absent section
   * would be ambiguous; an empty list is a statement.
   *
   * The envelope's `suppressions` section is not adopted: it summarises findings
   * a human accepted, and a receipt that carries no findings has none to accept.
   * Claiming "nothing was suppressed" about a posture that does not exist would
   * be the kind of empty assurance the section was invented to prevent.
   */
  provenance: ReceiptProvenance;
};

/** The exact bytes of `receipt.json` in the bundle — and therefore the exact
 *  bytes the detached signature covers. One function so the writer and the signer
 *  cannot disagree about a trailing newline. */
export function receiptJson(receipt: EvidenceReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/**
 * The canonical form the v3 content hash covers: one JSON document, written by
 * `JSON.stringify`, which escapes every delimiter inside a string, so two different
 * inputs can never serialise alike.
 *
 *     ["diagram.receipt/v3", cloud, nodes, edges, plan]
 *
 *     node = [id, category, kind, label, [[attribute key, value], ...], flagged]
 *     edge = [source, target, origin]
 *     plan = [[file name, content or null when the file is missing], ...]
 *
 * Nodes, edges and attributes are sorted by comparing their JSON text in UTF-16
 * code-unit order (never a locale's), which is the same on every machine; plan files
 * stay in the order the receipt records, and are hashed with their names so text cannot
 * move from one file to the next unnoticed. Ordering and canvas positions of the model
 * do not participate, because moving a box does not change what will be built; ids,
 * categories, kinds, labels, attributes, review flags and edges all do. The string is
 * encoded as UTF-8 and hashed with SHA-256.
 */
function canonicalPayload(args: { model: InfraModel; cloud: Cloud; files: TerraformFile[]; order: string[] }): string {
  const text = (row: unknown[]) => JSON.stringify(row);
  const nodes = args.model.nodes
    .map((n) => [
      n.id,
      n.category,
      n.kind,
      n.label,
      Object.entries(n.attributes ?? {}).sort(([a, x], [b, y]) => compareText(a, b) || compareText(x, y)),
      Boolean(n.flag),
    ])
    .sort((a, b) => compareText(text(a), text(b)));
  const edges = args.model.edges
    .map((e) => [e.source, e.target, e.origin])
    .sort((a, b) => compareText(text(a), text(b)));
  const plan = args.order.map((name) => [name, args.files.find((f) => f.name === name)?.content ?? null]);
  return JSON.stringify([RECEIPT_SCHEMA, args.cloud, nodes, edges, plan]);
}

/**
 * The serialization `diagram.receipt/v2` receipts were signed over, kept exactly so
 * they still verify. It sorts with the process locale and joins fields with unescaped
 * `:`, `,`, `=`, `|` and `#`, so it can disagree between machines and let different
 * models serialise alike; it is read here and never written.
 */
function legacyCanonicalModel(model: InfraModel): string {
  const nodes = [...model.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => {
      const attrs = n.attributes
        ? Object.entries(n.attributes)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : "";
      return `${n.id}:${n.category}:${n.kind}:${n.label}:${attrs}:${n.flag ? "flagged" : "clear"}`;
    })
    .join("|");
  const edges = [...model.edges]
    .map((e) => `${e.source}>${e.target}:${e.origin}`)
    .sort()
    .join("|");
  return `${nodes}#${edges}`;
}

/** Plan files concatenated in the order the receipt records. */
function planText(files: TerraformFile[], order: string[]): string {
  return order
    .map((name) => files.find((f) => f.name === name)?.content ?? "")
    .join("\n");
}

/** SHA-256 via WebCrypto, which both Node and every supported browser provide. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The content hash of a model and its plan under a receipt schema: the canonical form
 * above for `diagram.receipt/v3` (the default), the original serialization for any other
 * id the verifier accepts. `files` are the plan files and `order` the names, in the
 * order the receipt records them.
 */
export async function contentHashFor(
  args: { model: InfraModel; cloud: Cloud; files: TerraformFile[]; order: string[] },
  schema: string = RECEIPT_SCHEMA,
): Promise<string> {
  const payload =
    schema === RECEIPT_SCHEMA
      ? canonicalPayload(args)
      : `${legacyCanonicalModel(args.model)}::${args.cloud}::${planText(args.files, args.order)}`;
  return `sha256:${await sha256Hex(payload)}`;
}

/* ------------------------------------------------------------------ bundle -- */

export type BundleEntry = { name: string; content: string };

/**
 * Assemble the downloadable bundle. The plan files sit under `plan/` but are hashed
 * by their bare names, which is why the receipt records the order explicitly rather
 * than relying on however a zip tool happens to list them.
 */
export function buildBundle(
  receipt: EvidenceReceipt,
  model: InfraModel,
  files: TerraformFile[],
  attestation?: { detachedSignature: string; publicKeyPem: string } | null,
): BundleEntry[] {
  return [
    { name: RECEIPT_FILE, content: receiptJson(receipt) },
    // A second, detached signature over receipt.json's exact bytes, in the form
    // `infraweaver verify-evidence <bundle> <sig> <pubkey>` already reads — so one
    // verifier covers both products, and an auditor with the CLI needs no browser.
    // The in-receipt signature over the content hash is unchanged and is still
    // what `verifyBundle` checks.
    ...(attestation
      ? [
          { name: RECEIPT_SIGNATURE_FILE, content: `${attestation.detachedSignature}\n` },
          { name: SIGNING_KEY_FILE, content: attestation.publicKeyPem },
        ]
      : []),
    { name: "model.json", content: `${JSON.stringify(model, null, 2)}\n` },
    { name: "explanation.txt", content: `${receipt.explanation}\n` },
    ...files.map((file) => ({ name: `plan/${file.name}`, content: file.content })),
  ];
}

/** Read a bundle's plan files back out, stripping the `plan/` prefix. */
export function bundlePlanFiles(entries: BundleEntry[]): TerraformFile[] {
  return entries
    .filter((e) => e.name.startsWith("plan/"))
    .map((e) => ({ name: e.name.slice("plan/".length), content: e.content }));
}
