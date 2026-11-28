// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeFromPrompt } from "terragram-engine/engine";
import {
  attributeOf,
  extractReferences,
  objectLiteral,
  parseHcl,
  renderDocument,
  stringValue,
} from "terragram-engine/hcl";
import { addNode, connectNodes, setNodeAttribute } from "terragram-engine/inspector";
import { EMPTY_MODEL } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";
import { SAMPLE_TERRAFORM, SAMPLE_TERRAFORM_PARTIAL } from "terragram-engine/samples";
import { emitTerraform } from "terragram-engine/terraform";

describe("hcl reader", () => {
  it("reads blocks, labels, nested blocks and multi-line values", () => {
    const blocks = parseHcl(`
resource "aws_instance" "web" {
  ami           = "ami-123"
  instance_type = "t3.medium"

  tags = {
    Name = "web"
  }

  root_block_device {
    volume_size = 20
  }
}
`);
    assert.equal(blocks.length, 1);
    const block = blocks[0]!;
    assert.equal(block.type, "resource");
    assert.deepEqual(block.labels, ["aws_instance", "web"]);
    assert.equal(stringValue(attributeOf(block, "ami")), "ami-123");
    assert.match(attributeOf(block, "tags") ?? "", /Name/);
    assert.equal(block.blocks[0]?.type, "root_block_device");
  });

  it("ignores comments and heredocs rather than mis-parsing them", () => {
    const blocks = parseHcl(`
# a leading comment with a { brace
/* and a block comment
   spanning lines "with quotes" */
resource "aws_s3_bucket" "data" {
  bucket = "x" // trailing comment
  policy = <<-EOT
    { "Statement": [] }
  EOT
}
`);
    assert.equal(blocks.length, 1);
    assert.equal(stringValue(attributeOf(blocks[0]!, "bucket")), "x");
    assert.match(attributeOf(blocks[0]!, "policy") ?? "", /Statement/);
  });

  it("finds resource references but not variables or plain strings", () => {
    assert.deepEqual(extractReferences("azurerm_service_plan.web.id"), ["azurerm_service_plan.web"]);
    assert.deepEqual(extractReferences('"${azurerm_redis_cache.c.hostname}"'), [
      "azurerm_redis_cache.c",
    ]);
    assert.deepEqual(extractReferences("var.name_prefix"), []);
    assert.deepEqual(extractReferences('"example.gov.uk"'), []);
  });

  it("reads a heredoc like a string: its words are text, only an interpolation is a reference", () => {
    assert.deepEqual(extractReferences("<<-EOT\n  module.network.resource_id\nEOT"), []);
    assert.deepEqual(extractReferences("<<-EOT\n  see module.network.resource_id and ${module.group.resource_id}\nEOT"), ["module.group"]);
  });

  it("answers an object only for one written out, so a reader that must see every entry is never told [] for a call", () => {
    for (const expr of ["var.subnets", "merge({}, var.subnets)", "{ for k, v in var.x : k => v }", "{}", 'cond ? { a = 1 } : {}', "{ a = 1 }.a", "{ a = 1 } == var.x", undefined]) {
      assert.equal(objectLiteral(expr), undefined, String(expr));
    }
    assert.deepEqual(objectLiteral('{\n  a = "}"\n  b = { c = 1 }\n}'), [
      { key: "a", value: '"}"' },
      { key: "b", value: "{ c = 1 }" },
    ]);
  });

  it("renders what it parses", () => {
    const source = `resource "aws_s3_bucket" "data" {\n  bucket = "x"\n}`;
    const rendered = renderDocument(parseHcl(source));
    assert.match(rendered, /resource "aws_s3_bucket" "data"/);
    assert.match(rendered, /bucket = "x"/);
  });
});

describe("parseTerraform", () => {
  it("reads the file's own topology instead of guessing a spine", () => {
    const result = parseTerraform(SAMPLE_TERRAFORM);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // The sample's web app references the database and the cache, so those edges come
    // from the file — not from our spine rules — and the model is marked manual.
    assert.equal(result.model.topology, "manual");
    const app = result.model.nodes.find((n) => n.kind === "app-service");
    const pg = result.model.nodes.find((n) => n.kind === "postgres");
    const redis = result.model.nodes.find((n) => n.kind === "redis-cache");
    assert.ok(app && pg && redis);
    assert.ok(
      result.model.edges.some(
        (e) => e.source === app?.id && e.target === pg?.id && e.origin === "user",
      ),
      "expected an app -> postgres edge read from the file",
    );
    assert.ok(
      result.model.edges.some((e) => e.source === app?.id && e.target === redis?.id),
      "expected an app -> redis edge read from the file",
    );
  });

  it("reads attributes back so the inspector shows what the file says", () => {
    const result = parseTerraform(SAMPLE_TERRAFORM);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const pg = result.model.nodes.find((n) => n.kind === "postgres");
    assert.equal(pg?.attributes?.["PostgreSQL version"], "PostgreSQL 16");
    const redis = result.model.nodes.find((n) => n.kind === "redis-cache");
    assert.equal(redis?.attributes?.["Cache SKU"], "Standard (C1)");
  });

  it("detects the target cloud from the file", () => {
    const azure = parseTerraform(SAMPLE_TERRAFORM);
    assert.equal(azure.ok && azure.cloud, "azure");
    const aws = parseTerraform('resource "aws_s3_bucket" "d" {\n  bucket = "b"\n}');
    assert.equal(aws.ok && aws.cloud, "aws");
  });

  it("keeps an untranslatable module on the diagram, flagged, rather than failing", () => {
    const result = parseTerraform(SAMPLE_TERRAFORM_PARTIAL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.model.nodes.some((n) => n.kind === "object-storage"));
    const external = result.model.nodes.find((n) => n.kind === "external");
    assert.ok(external, "the module block should appear as an untranslated node");
    assert.ok(external?.flag, "the untranslated node should be flagged");
    assert.ok(result.untranslated.some((u) => u.startsWith("module.")));
  });

  it("rejects free text that is not Terraform", () => {
    assert.equal(parseTerraform("just some notes, nothing here").ok, false);
  });

  it("rejects a file whose resources are all unmappable", () => {
    const result = parseTerraform('resource "oci_objectstorage_bucket" "b" {\n  name = "x"\n}');
    assert.equal(result.ok, false);
  });
});

describe("emit round-trip", () => {
  it("reproduces kinds, attributes and topology from its own output", () => {
    const { model } = composeFromPrompt("A web app with a Postgres database and Redis cache");
    const chosen = setNodeAttribute(model, "postgres", "PostgreSQL version", "PostgreSQL 17");

    const emitted = emitTerraform(chosen, "azure");
    const parsed = parseTerraform(emitted.files[0]?.content ?? "");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    const kinds = parsed.model.nodes.map((n) => n.kind);
    for (const expected of ["front-door", "app-service", "postgres", "redis-cache"]) {
      assert.ok(kinds.includes(expected), `${expected} missing from ${kinds.join(", ")}`);
    }

    const pg = parsed.model.nodes.find((n) => n.kind === "postgres");
    assert.equal(pg?.attributes?.["PostgreSQL version"], "PostgreSQL 17");

    const app = parsed.model.nodes.find((n) => n.kind === "app-service");
    assert.ok(
      parsed.model.edges.some((e) => e.source === app?.id && e.target === pg?.id),
      "the app -> database edge should survive the round trip",
    );
  });
});

describe("graph-aware emit", () => {
  it("turns an edge into a real provider reference, not just a picture", () => {
    const { model } = composeFromPrompt("A web app with a Postgres database");
    const main = emitTerraform(model, "azure").files[0]?.content ?? "";
    assert.match(
      main,
      /DATABASE_HOST\s*=\s*module\.postgres\.fqdn/,
      "the app -> database edge should appear as an app setting",
    );
  });

  it("wires an ingress tier to the app it fronts", () => {
    const { model } = composeFromPrompt("A web app behind a CDN");
    const main = emitTerraform(model, "azure").files[0]?.content ?? "";
    // The profile module owns its origins, so the wire is a map entry on the
    // call rather than a resource beside it — and it still names the app.
    assert.match(main, /front_door_origins = \{/);
    assert.match(main, /host_name\s*=\s*module\.app_service\.resource_uri/);
    assert.match(main, /front_door_routes = \{/);
  });

  it("falls back to depends_on where the provider has no natural attribute", () => {
    const { model } = composeFromPrompt("A web app with a Postgres database");
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    // An EC2 web tier has no settings map, so its edge to the database module is an
    // explicit dependency on the module call.
    assert.match(main, /depends_on\s*=\s*\[module\.postgres\]/);
  });

  it("emits two non-colliding blocks for two nodes of the same kind", () => {
    const first = addNode(EMPTY_MODEL, "postgres");
    assert.ok(first);
    const second = addNode(first!.model, "postgres");
    assert.ok(second);
    assert.notEqual(first!.id, second!.id);

    const main = emitTerraform(second!.model, "azure").files[0]?.content ?? "";
    const names = [...main.matchAll(/module "(postgres[^"]*)"/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
  });

  it("emits a reference for an edge the reviewer drew by hand", () => {
    const withApp = addNode(EMPTY_MODEL, "app-service");
    assert.ok(withApp);
    const withDb = addNode(withApp!.model, "postgres");
    assert.ok(withDb);
    const connected = connectNodes(withDb!.model, withApp!.id, withDb!.id);
    assert.equal(connected.topology, "manual");

    const main = emitTerraform(connected, "azure").files[0]?.content ?? "";
    assert.match(main, /DATABASE_HOST\s*=\s*module\.postgres\.fqdn/);
  });
});
