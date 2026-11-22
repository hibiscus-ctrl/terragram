import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeFromPrompt } from "../src/features/workspace/engine.ts";
import {
  attributeValue,
  fieldsForKind,
  resolveNodeFlag,
  setNodeAttribute,
  setNodeLabel,
} from "../src/features/workspace/inspector.ts";
import { countFlags } from "../src/features/workspace/model.ts";
import { emitTerraform } from "../src/features/workspace/terraform.ts";
import { buildEvidenceReceipt } from "../src/features/workspace/sign.ts";

const WEB_PROMPT = "A web app with a Postgres database and Redis cache";

describe("inspector fields", () => {
  it("exposes a compute tier for app-service and a version for postgres", () => {
    assert.ok(fieldsForKind("app-service").some((f) => f.key === "Compute tier"));
    assert.ok(fieldsForKind("postgres").some((f) => f.key === "PostgreSQL version"));
    assert.equal(fieldsForKind("entra-id").length, 0);
  });

  it("reads the fallback until a reviewer chooses a value", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const pg = model.nodes.find((n) => n.kind === "postgres");
    assert.ok(pg);
    const field = fieldsForKind("postgres")[0]!;
    assert.equal(attributeValue(pg!, field), "PostgreSQL 16");
    const next = setNodeAttribute(model, pg!.id, field.key, "PostgreSQL 15");
    const pg2 = next.nodes.find((n) => n.id === pg!.id)!;
    assert.equal(attributeValue(pg2, field), "PostgreSQL 15");
  });
});

describe("resolveNodeFlag", () => {
  it("clears exactly one node's review flag", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const flaggedBefore = countFlags(model);
    assert.ok(flaggedBefore >= 1);
    const pg = model.nodes.find((n) => n.kind === "postgres")!;
    const next = resolveNodeFlag(model, pg.id);
    assert.equal(countFlags(next), flaggedBefore - 1);
    assert.equal(next.nodes.find((n) => n.id === pg.id)!.flag, null);
  });
});

describe("setNodeLabel", () => {
  it("renames a node and ignores empty input", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const pg = model.nodes.find((n) => n.kind === "postgres")!;
    assert.equal(setNodeLabel(model, pg.id, "  ").nodes.find((n) => n.id === pg.id)!.label, pg.label);
    const renamed = setNodeLabel(model, pg.id, "Primary DB");
    assert.equal(renamed.nodes.find((n) => n.id === pg.id)!.label, "Primary DB");
  });
});

describe("attribute-aware Terraform emit", () => {
  it("reflects a chosen postgres version and compute tier in the plan", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const pg = model.nodes.find((n) => n.kind === "postgres")!;
    const app = model.nodes.find((n) => n.kind === "app-service")!;
    let next = setNodeAttribute(model, pg.id, "PostgreSQL version", "PostgreSQL 15");
    next = setNodeAttribute(next, app.id, "Compute tier", "Production (P3v3)");

    const azure = emitTerraform(next, "azure").files.map((f) => f.content).join("\n");
    assert.match(azure, /version\s+=\s+"15"/);
    assert.match(azure, /sku_name\s+=\s+"P3v3"/);

    const aws = emitTerraform(next, "aws").files.map((f) => f.content).join("\n");
    assert.match(aws, /engine_version\s+=\s+"15"/);
    assert.match(aws, /instance_type\s+=\s+"t3\.xlarge"/);
  });
});

describe("buildEvidenceReceipt", () => {
  it("produces a stable sha256 content hash and ships unsigned without a key", async () => {
    delete process.env.EVIDENCE_SIGNING_KEY;
    const { model } = composeFromPrompt(WEB_PROMPT);
    const a = await buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-07-10T00:00:00Z");
    const b = await buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-07-10T00:00:00Z");
    assert.match(a.receipt.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(a.receipt.contentHash, b.receipt.contentHash);
    assert.equal(a.receipt.signed, false);
    assert.equal(a.receipt.signature, null);
    assert.equal(a.receipt.publicKey, null);
    assert.equal(a.receipt.approver, "alice");
  });

  it("changes the content hash when a resolved attribute changes the plan", async () => {
    delete process.env.EVIDENCE_SIGNING_KEY;
    const { model } = composeFromPrompt(WEB_PROMPT);
    const pg = model.nodes.find((n) => n.kind === "postgres")!;
    const changed = setNodeAttribute(model, pg.id, "PostgreSQL version", "PostgreSQL 14");
    const base = await buildEvidenceReceipt(model, "azure", "deterministic", "a", "2026-07-10T00:00:00Z");
    const next = await buildEvidenceReceipt(changed, "azure", "deterministic", "a", "2026-07-10T00:00:00Z");
    assert.notEqual(base.receipt.contentHash, next.receipt.contentHash);
  });

  it("carries the plain-English description the approver was shown", async () => {
    delete process.env.EVIDENCE_SIGNING_KEY;
    const { model } = composeFromPrompt(WEB_PROMPT);
    const { receipt } = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "a",
      "2026-07-10T00:00:00Z",
    );
    assert.match(receipt.explanation, /UK South/);
    assert.match(receipt.explanation, /Needs confirming/);
  });
});
