// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { z } from "zod";

import { buildEvidenceReceipt } from "terragram-engine/build-receipt";
import { composeFromPrompt } from "terragram-engine/engine";
import { parseMermaid } from "terragram-engine/interchange";
import { type InfraModel, MODEL_SCHEMA, modelDocumentSchema } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";
import { type EvidenceReceipt, type ReceiptProvenance, RECEIPT_SCHEMA } from "terragram-engine/receipt";
import { evidenceReceiptSchema } from "terragram-engine/receipt-schema";
import { SAMPLE_MERMAID, SAMPLE_TERRAFORM } from "terragram-engine/samples";
import { templateModel, WORKSPACE_TEMPLATES } from "terragram-engine/templates";

/**
 * The published JSON Schemas are what a reader outside this repo validates against,
 * so they are tested the way such a reader uses them: loaded from schemas/ with a
 * stock validator, and handed the documents the engine really produces.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The receipt schema and the receipt type cannot drift apart: this stops compiling
// if either changes without the other.
const receiptSchemaMatchesType: Equal<z.infer<typeof evidenceReceiptSchema>, EvidenceReceipt> = true;
// The provenance is the shape the sibling evidence envelope (`@infraweaver-io/attest`, 0.1.x) carries, so one
// reader understands both: this stops compiling if it changes without the schema and the readers being told.
const provenanceShape: Equal<
  ReceiptProvenance,
  { model: string | null; node: string; scanners: { tool: string; version: string | null }[] }
> = true;

function load(file: string): object {
  return JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8")) as object;
}

function validator(file: string) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(load(file));
}

const validModel = validator("model.v1.schema.json");
const validReceipt = validator("receipt.v3.schema.json");
const validLegacyReceipt = validator("receipt.v2.schema.json");

describe("schemas/model.v1.schema.json", () => {
  const WEB = composeFromPrompt("A web app with a Postgres database and Redis cache").model;
  const documents: Array<[string, unknown]> = [
    ["a composed model", WEB],
    ["a template", templateModel(WORKSPACE_TEMPLATES[0]!)],
    ["parsed Terraform", (parseTerraform(SAMPLE_TERRAFORM) as { model: InfraModel }).model],
    ["parsed Mermaid", (parseMermaid(SAMPLE_MERMAID) as { model: InfraModel }).model],
    ["a document with its schema id and cloud", { ...WEB, schema: MODEL_SCHEMA, cloud: "aws" }],
    ["an empty model", { nodes: [], edges: [] }],
  ];

  for (const [name, doc] of documents) {
    it(`accepts ${name}, and the engine's own reader agrees`, () => {
      assert.equal(validModel(doc), true, JSON.stringify(validModel.errors));
      assert.equal(modelDocumentSchema.safeParse(doc).success, true);
    });
  }

  it("accepts a node without the fields that have defaults", () => {
    const doc = {
      nodes: [{ id: "a", category: "compute", kind: "app-service", label: "App" }],
      edges: [{ id: "e", source: "a", target: "a" }],
    };
    assert.equal(validModel(doc), true);
    assert.equal(modelDocumentSchema.safeParse(doc).success, true);
  });

  const node = { id: "n", category: "compute", kind: "app-service", label: "App" };
  const rejected: Array<[string, unknown]> = [
    ["more than 300 nodes", { nodes: Array.from({ length: 301 }, () => node), edges: [] }],
    [
      "more than 600 edges",
      { nodes: [], edges: Array.from({ length: 601 }, () => ({ id: "e", source: "a", target: "b" })) },
    ],
    ["a node with an unknown category", { nodes: [{ ...node, category: "quantum" }], edges: [] }],
    ["a node id over 80 characters", { nodes: [{ ...node, id: "x".repeat(81) }], edges: [] }],
    ["an unknown cloud", { nodes: [], edges: [], cloud: "gcp" }],
    ["a different schema id", { nodes: [], edges: [], schema: "diagram.model/v9" }],
    ["a model with no edges list", { nodes: [] }],
  ];

  for (const [name, doc] of rejected) {
    it(`rejects ${name}, as the engine's own reader does`, () => {
      assert.equal(validModel(doc), false);
      assert.equal(modelDocumentSchema.safeParse(doc).success, false);
    });
  }

  it("states the caps the engine enforces", () => {
    const schema = load("model.v1.schema.json") as {
      properties: { nodes: { maxItems: number }; edges: { maxItems: number } };
    };
    assert.equal(schema.properties.nodes.maxItems, 300);
    assert.equal(schema.properties.edges.maxItems, 600);
  });
});

describe("schemas/receipt.v3.schema.json", () => {
  it("accepts the receipts the engine writes, signed or not", async () => {
    const { model } = composeFromPrompt("A web app with a Postgres database and Redis cache");
    const unsigned = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "alice",
      "2026-09-11T00:00:00Z",
      { nodeVersion: "v24.0.0" },
    );
    const signer = {
      keyId: "test-key",
      signedAt: "2026-09-11T00:00:01Z",
      publicKey: "AAAA",
      publicKeyPem: "pem",
      sign: () => "c2lnbmF0dXJl",
    };
    const signed = await buildEvidenceReceipt(
      model,
      "aws",
      "managed",
      "bob",
      "2026-09-11T00:00:00Z",
      { nodeVersion: "v24.0.0", tool: "opentofu", signer, inferenceModel: null },
    );
    for (const { receipt } of [unsigned, signed]) {
      assert.equal(receipt.schema, RECEIPT_SCHEMA);
      assert.equal(validReceipt(receipt), true, JSON.stringify(validReceipt.errors));
      assert.equal(evidenceReceiptSchema.safeParse(receipt).success, true);
    }
    assert.equal(signed.receipt.signed, true);
  });

  it("rejects a receipt that is not one", async () => {
    const { model } = composeFromPrompt("A web app with a Postgres database");
    const { receipt } = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "alice",
      "2026-09-11T00:00:00Z",
      { nodeVersion: "v24.0.0" },
    );
    const broken: Array<[string, unknown]> = [
      ["a different schema id", { ...receipt, schema: "diagram.receipt/v2" }],
      ["a malformed hash", { ...receipt, contentHash: "sha256:abc" }],
      ["an unknown tool", { ...receipt, tool: "pulumi" }],
      ["no provenance", { ...receipt, provenance: undefined }],
      ["a negative resource count", { ...receipt, resourceCount: -1 }],
      ["a date that is not a date", { ...receipt, approvedAt: "yesterday" }],
    ];
    for (const [name, doc] of broken) {
      assert.equal(validReceipt(doc), false, name);
      assert.equal(evidenceReceiptSchema.safeParse(doc).success, false, name);
    }
  });

  it("holds the type checks above", () => {
    assert.equal(receiptSchemaMatchesType && provenanceShape, true);
  });
});

describe("schemas/receipt.v2.schema.json", () => {
  it("still accepts a receipt issued under diagram.receipt/v2, and refuses a v3 one", () => {
    const issued = JSON.parse(
      readFileSync(new URL("./fixtures/receipt-v2/receipt.json", import.meta.url), "utf8"),
    ) as { schema: string };
    assert.equal(issued.schema, "diagram.receipt/v2");
    assert.equal(validLegacyReceipt(issued), true, JSON.stringify(validLegacyReceipt.errors));
    assert.equal(validReceipt(issued), false);
    assert.equal(validLegacyReceipt({ ...issued, schema: RECEIPT_SCHEMA }), false);
  });
});
