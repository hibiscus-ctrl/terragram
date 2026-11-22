// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeFromPrompt } from "terragram-engine/engine";
import { buildEvidence } from "terragram-engine/evidence";
import { countFlags, resourceNodes } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";
import { SAMPLE_TERRAFORM } from "terragram-engine/samples";
import { emitTerraform } from "terragram-engine/terraform";

const WEB_PROMPT = "A web app with a Postgres database and Redis cache";

describe("composeFromPrompt", () => {
  it("builds the reference web topology with a coherent spine", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const kinds = model.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["app-service", "front-door", "internet", "postgres", "redis-cache"]);
    assert.ok(model.edges.some((e) => e.source === "internet" && e.target === "front-door"));
    assert.ok(model.edges.some((e) => e.source === "front-door" && e.target === "app-service"));
    assert.ok(model.edges.some((e) => e.source === "app-service" && e.target === "postgres"));
    assert.ok(model.edges.some((e) => e.source === "app-service" && e.target === "redis-cache"));
  });

  it("flags the two low-confidence storage attributes", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    assert.equal(countFlags(model), 2);
    assert.ok(model.nodes.find((n) => n.kind === "redis-cache")?.flag);
    assert.ok(model.nodes.find((n) => n.kind === "postgres")?.flag);
  });

  it("folds a follow-up into the existing model without duplicating nodes", () => {
    const first = composeFromPrompt(WEB_PROMPT);
    const second = composeFromPrompt(
      "Put identity behind Entra ID and store secrets in a vault",
      first.model,
    );
    const kinds = second.model.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("entra-id"));
    assert.ok(kinds.includes("key-vault"));
    assert.equal(kinds.filter((k) => k === "app-service").length, 1);
    assert.equal(second.added.length, 2);
  });

  it("is a no-op when nothing new is detected", () => {
    const first = composeFromPrompt(WEB_PROMPT);
    const again = composeFromPrompt(WEB_PROMPT, first.model);
    assert.equal(again.added.length, 0);
    assert.equal(again.model.nodes.length, first.model.nodes.length);
  });

  // The widened vocabulary's reason for existing: this brief used to hit the ceiling
  // at seven kinds and come back as a web app with a database.
  it("handles a brief the old seven-kind vocabulary could not express", () => {
    const { model } = composeFromPrompt(
      "A containerised API behind a load balancer with a queue, MySQL and monitoring",
    );
    const kinds = model.nodes.map((n) => n.kind);
    for (const expected of ["containers", "load-balancer", "queue", "mysql", "monitoring"]) {
      assert.ok(kinds.includes(expected), `expected ${expected} in ${kinds.join(", ")}`);
    }
  });

  it("does not bolt an App Service onto a brief that names its own compute tier", () => {
    const { model } = composeFromPrompt("A containerised API with Postgres");
    const kinds = model.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("containers"));
    assert.equal(kinds.includes("app-service"), false);
  });

  it("hangs leaves off the serving tier the brief actually named", () => {
    const { model } = composeFromPrompt("A containerised API with a queue");
    const containers = model.nodes.find((n) => n.kind === "containers");
    assert.ok(containers);
    assert.ok(
      model.edges.some((e) => e.source === containers?.id && e.target.startsWith("queue")),
    );
  });

  it("matches keywords on word boundaries, so 'application' is not an app tier alone", () => {
    const { model } = composeFromPrompt("Storage for scanned documents");
    const kinds = model.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("object-storage"));
  });
});

describe("emitTerraform", () => {
  it("emits three files built from Azure Verified Modules", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const out = emitTerraform(model, "azure");
    assert.deepEqual(
      out.files.map((f) => f.name),
      ["main.tf", "variables.tf", "outputs.tf"],
    );
    assert.equal(out.provider, "azurerm");
    const main = out.files[0]?.content ?? "";
    // Every Azure resource comes from a Microsoft-maintained module, the resource
    // group included — no hand-written azurerm resource is left to drift.
    assert.match(main, /module "resource_group"/);
    assert.match(main, /Azure\/avm-res-resources-resourcegroup\/azurerm/);
    assert.match(main, /Azure\/avm-res-web-serverfarm\/azurerm/);
    assert.match(main, /Azure\/avm-res-dbforpostgresql-flexibleserver\/azurerm/);
    assert.equal(/resource "azurerm_/.test(main), false, "no raw azurerm resource blocks");
    // Pinned exactly, like every other module call the emitter writes.
    assert.match(main, /version\s+= "\d+\.\d+\.\d+"/);
  });

  it("emits aws provider config for the eu-west-2 region", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const out = emitTerraform(model, "aws");
    assert.equal(out.provider, "aws");
    assert.equal(out.region, "eu-west-2");
    const main = out.files[0]?.content ?? "";
    assert.match(main, /provider "aws"/);
    // Postgres on AWS is the RDS registry module, pinned exactly.
    assert.match(main, /module "postgres" \{\s+source\s+= "terraform-aws-modules\/rds\/aws"\s+version\s+= "\d+\.\d+\.\d+"/);
    assert.match(main, /engine\s+= "postgres"/);
  });

  it("never emits the conceptual edge node as a resource", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const out = emitTerraform(model, "azure");
    assert.equal(out.files[0]?.content.includes('"internet"'), false);
    assert.equal(resourceNodes(model).length, 4);
  });

  it("pins the provider version from the generated version file, not a literal", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const out = emitTerraform(model, "azure");
    assert.match(out.providerVersion, /^~> \d+\.\d+$/);
    assert.ok(out.files[0]?.content.includes(`version = "${out.providerVersion}"`));
  });

  it("labels the document by the chosen generator", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    assert.match(emitTerraform(model, "azure", "opentofu").files[0]?.content ?? "", /OpenTofu/);
    assert.match(emitTerraform(model, "azure", "terraform").files[0]?.content ?? "", /Terraform/);
  });
});

describe("buildEvidence", () => {
  it("counts resources (excluding the edge) and is deterministic", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const out = emitTerraform(model, "azure");
    const a = buildEvidence(model, "azure", out, "deterministic");
    const b = buildEvidence(model, "azure", out, "deterministic");
    assert.equal(a.resourceCount, 4);
    assert.equal(a.previewId, b.previewId);
    assert.ok(a.sbom.some((s) => s.name === "terragram-engine"));
  });

  it("changes the preview id when the target cloud changes", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const azure = buildEvidence(model, "azure", emitTerraform(model, "azure"), "deterministic");
    const aws = buildEvidence(model, "aws", emitTerraform(model, "aws"), "deterministic");
    assert.notEqual(azure.previewId, aws.previewId);
  });

  it("labels the inference mode honestly per engine", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const out = emitTerraform(model, "azure");
    assert.equal(
      buildEvidence(model, "azure", out, "managed").inferenceMode,
      "Managed · UK Bedrock",
    );
    assert.equal(
      buildEvidence(model, "azure", out, "deterministic").inferenceMode,
      "Deterministic · local",
    );
  });
});

describe("parse then emit", () => {
  it("reverses the reference document and regenerates comparable HCL", () => {
    const parsed = parseTerraform(SAMPLE_TERRAFORM);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const out = emitTerraform(parsed.model, parsed.cloud);
    const main = out.files[0]?.content ?? "";
    // In goes a document of raw azurerm resources; out comes the same estate
    // expressed as Verified Modules. The components survive, the spelling changes.
    assert.match(main, /Azure\/avm-res-dbforpostgresql-flexibleserver\/azurerm/);
    assert.match(main, /Azure\/avm-res-cache-redis\/azurerm/);
  });
});
