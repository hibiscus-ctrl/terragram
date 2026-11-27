// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { CLOUDS, GENERATED_CLOUDS } from "./model.ts";
import { LEGACY_RECEIPT_SCHEMA, RECEIPT_SCHEMA } from "./receipt.ts";

/**
 * The evidence receipt as a schema: the contract `receipt.json` keeps, written so a
 * reader who has never seen `receipt.ts` can validate one. `schemas/receipt.v3.schema.json`
 * is generated from this (`npm run schemas:gen`), and a test holds it two-way
 * assignable to the `EvidenceReceipt` type, so neither can change without the other.
 * `schemas/receipt.v2.schema.json` stays published for the receipts already issued under
 * `diagram.receipt/v2`: the same document, whose content hash is the original one.
 *
 * Reading is not what the verifier does with it: `verifyBundle` accepts v2 and older
 * receipts too and judges the hash and signature itself. This describes a receipt this
 * build writes.
 */

const hexHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256: followed by 64 hex digits");
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "an ISO 8601 date-time")
  .meta({ format: "date-time" });

/** The v3 content hash, as the published schema words it. The form itself is defined
 *  (and commented) beside the code that computes it, `canonicalPayload` in `receipt.ts`. */
const CONTENT_HASH_V3 =
  'SHA-256 over the UTF-8 bytes of one JSON document, as JSON.stringify writes it: ["diagram.receipt/v3", cloud, nodes, edges, plan]. ' +
  "A node is [id, category, kind, label, [[attribute key, value], ...], flagged]; an edge is [source, target, origin]; " +
  "plan is [[file name, file content or null when missing], ...] in the order of the receipt's plan array. " +
  "Nodes, edges and attributes are sorted by their JSON text in UTF-16 code-unit order, never a locale's, so the hash " +
  "is the same on every machine, and every string is escaped, so two different models never serialise alike. " +
  "Node and edge order, canvas positions and edge ids do not participate.";

const receiptBody = {
  /** Whether `signature` is present. A receipt never claims a signature it lacks. */
  signed: z.boolean(),
  keyId: z.string().nullable(),
  signedAt: isoDateTime.nullable(),
  /** Detached Ed25519 signature over `contentHash`, base64. */
  signature: z.string().nullable(),
  /** Base64 SPKI of the signing key, so the bundle verifies with nothing else. */
  publicKey: z.string().nullable(),
  approver: z.string(),
  approvedAt: isoDateTime,
  cloud: z.enum(CLOUDS),
  region: z.string(),
  regionLabel: z.string(),
  tool: z.enum(["terraform", "opentofu"]),
  engine: z.enum(["managed", "deterministic"]),
  resourceCount: z.number().int().min(0),
  /** The engine, the provider and every registry module at its pinned version. */
  sbom: z.array(z.object({ name: z.string(), version: z.string() })),
  /** Components the diagram had that generation could not build on this cloud. */
  omitted: z.array(z.string()),
  /** The plain-English description the approver was shown. */
  explanation: z.string(),
  /** Plan file names, in the order they are hashed. */
  plan: z.array(z.string()),
  provenance: z.object({
    model: z.string().nullable(),
    node: z.string(),
    scanners: z.array(z.object({ tool: z.string(), version: z.string().nullable() })),
  }),
};

/** A receipt this build writes (`diagram.receipt/v3`). */
export const evidenceReceiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA),
  contentHash: hexHash.meta({ description: CONTENT_HASH_V3 }),
  ...receiptBody,
});

/** A receipt as issued under `diagram.receipt/v2`, whose content hash is the original. */
export const legacyEvidenceReceiptSchema = z.object({
  schema: z.literal(LEGACY_RECEIPT_SCHEMA),
  contentHash: hexHash,
  ...receiptBody,
  // Issued before Google Cloud was read: a v2 receipt is for a cloud that was generated.
  cloud: z.enum(GENERATED_CLOUDS),
});
