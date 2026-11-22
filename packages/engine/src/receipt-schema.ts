// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { CLOUDS } from "./model.ts";
import { RECEIPT_SCHEMA } from "./receipt.ts";

/**
 * The evidence receipt as a schema: the contract `receipt.json` keeps, written so a
 * reader who has never seen `receipt.ts` can validate one. `schemas/receipt.v2.schema.json`
 * is generated from this (`npm run schemas:gen`), and a test holds it two-way
 * assignable to the `EvidenceReceipt` type, so neither can change without the other.
 *
 * Reading is not what the verifier does with it: `verifyBundle` accepts v1 receipts
 * too and judges the hash and signature itself. This describes a receipt this build
 * writes.
 */

const hexHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256: followed by 64 hex digits");
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "an ISO 8601 date-time")
  .meta({ format: "date-time" });

export const evidenceReceiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA),
  /** SHA-256 over the canonical model, the cloud and the plan files, in `plan` order. */
  contentHash: hexHash,
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
});
