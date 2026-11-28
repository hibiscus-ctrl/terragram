// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { modelToSvg } from "terragram-engine/diagram-svg";
import { explainModel } from "terragram-engine/explain";
import { assessFeasibility } from "terragram-engine/feasibility";
import { parseHcl } from "terragram-engine/hcl";
import { cloudSpec, moduleSourceToKind, readSpec, resourceTypeToKind } from "terragram-engine/kinds";
import { parseTerraform } from "terragram-engine/parse";
import { buildBundle } from "terragram-engine/receipt";
import { emitTerraform } from "terragram-engine/terraform";
import { verifyBundle } from "terragram-engine/verify";

import { renderDiagram } from "../action/src/mermaid.ts";
import { diffModels } from "../action/src/model-diff.ts";
import { buildEvidenceReceipt, testSigner } from "./helpers/receipt.ts";

/**
 * Google Cloud is a cloud the engine reads: a file of google_* resources parses to a model,
 * is drawn and explained, and has a receipt, but no Terraform is generated for it. The fixture
 * is a small orders service written the way it would be by hand.
 */

const FIXTURE = readFileSync(new URL("./fixtures/gcp/main.tf", import.meta.url), "utf8");

function read(source: string) {
  const result = parseTerraform(source);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

const fixture = (name: string) => new URL(`./fixtures/gcp/${name}`, import.meta.url);
function golden(name: string, actual: string): void {
  const path = fixture(`golden/${name}`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path.pathname), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `${name} differs from its golden; UPDATE_GOLDEN=1 rewrites it`);
}

describe("reading a Google Cloud file", () => {
  const parsed = read(FIXTURE);

  it("is a gcp model, with every resource of the fixture translated", () => {
    assert.equal(parsed.cloud, "gcp");
    assert.deepEqual(parsed.untranslated, []);
    const kinds = parsed.model.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, [
      "containers",
      "data-warehouse",
      "dns",
      "entra-id",
      "entra-id",
      "functions",
      "internet",
      "key-vault",
      "kubernetes",
      "load-balancer",
      "monitoring",
      "object-storage",
      "object-storage",
      "postgres",
      "project",
      "queue",
      "redis-cache",
      "static-site",
      "virtual-machine",
      "vnet",
    ]);
  });

  it("attaches the secondary resources of a component to it, one node each", () => {
    // The record set joins its zone, the subscription its topic, the node pool its cluster, and so on.
    const count = (kind: string) => parsed.model.nodes.filter((n) => n.kind === kind).length;
    for (const kind of ["dns", "queue", "kubernetes", "load-balancer", "vnet", "key-vault"]) assert.equal(count(kind), 1, kind);
    assert.equal(count("object-storage"), 2);
    assert.equal(count("static-site"), 1);
  });

  it("reads what the inspector shows from the resources that say it", () => {
    const attributes = (kind: string) => parsed.model.nodes.find((n) => n.kind === kind)?.attributes;
    assert.deepEqual(attributes("dns"), { "Zone name": "orders.example.com" });
    assert.deepEqual(attributes("postgres"), { "PostgreSQL version": "PostgreSQL 16" });
  });

  it("draws the references between resources as edges, and not the project every resource names", () => {
    const edges = parsed.model.edges.map((e) => `${e.source}->${e.target}`);
    for (const wire of [
      "containers->postgres",
      "containers->queue",
      "containers->key-vault",
      "containers->vnet",
      "functions->object-storage",
      "functions->queue",
      "kubernetes->vnet",
      "virtual-machine->vnet",
      "redis-cache->vnet",
      "dns->load-balancer",
    ]) {
      assert.ok(edges.includes(wire), `missing ${wire} in ${edges.join(", ")}`);
    }
    assert.equal(parsed.model.edges.some((e) => e.target === "project"), false);
    assert.equal(parsed.model.topology, "manual");
  });

  it("enters the picture at a component, not at the project", () => {
    assert.equal(parsed.model.edges.find((e) => e.source === "internet")?.target, "dns");
  });

  it("is the same every time", () => {
    assert.deepEqual(read(FIXTURE), parsed);
  });

  it("keeps no value from the file but the ones the inspector shows", () => {
    const json = JSON.stringify(parsed.model);
    for (const secret of ["orders-api", "10.10.0.0/20", "billing_account", "db-custom-2-7680", "europe-west2"]) {
      assert.equal(json.includes(secret), false, secret);
    }
  });
});

describe("the Google Cloud reverse map", () => {
  const types: Array<[string, string]> = [
    ["google_project", "project"],
    ["google_compute_network", "vnet"],
    ["google_compute_subnetwork", "vnet"],
    ["google_compute_instance", "virtual-machine"],
    ["google_compute_instance_template", "virtual-machine"],
    ["google_compute_instance_group_manager", "virtual-machine"],
    ["google_container_cluster", "kubernetes"],
    ["google_container_node_pool", "kubernetes"],
    ["google_cloud_run_v2_service", "containers"],
    ["google_cloud_run_service", "containers"],
    ["google_cloudfunctions2_function", "functions"],
    ["google_cloudfunctions_function", "functions"],
    ["google_pubsub_topic", "queue"],
    ["google_pubsub_subscription", "queue"],
    ["google_secret_manager_secret", "key-vault"],
    ["google_kms_key_ring", "key-vault"],
    ["google_kms_crypto_key", "key-vault"],
    ["google_bigquery_dataset", "data-warehouse"],
    ["google_service_account", "entra-id"],
    ["google_dns_managed_zone", "dns"],
    ["google_compute_global_forwarding_rule", "load-balancer"],
    ["google_compute_url_map", "load-balancer"],
    ["google_compute_backend_service", "load-balancer"],
    ["google_redis_instance", "redis-cache"],
    ["google_firestore_database", "nosql"],
    ["google_monitoring_alert_policy", "monitoring"],
    ["google_compute_security_policy", "front-door"],
    ["google_app_engine_standard_app_version", "app-service"],
  ];
  for (const [type, kind] of types) {
    it(`maps ${type} to ${kind}`, () => {
      assert.equal(resourceTypeToKind(type, "gcp")?.kind, kind);
      assert.equal(resourceTypeToKind(type)?.cloud, "gcp");
    });
  }

  it("tells a bucket that serves a site from one that stores files, and Postgres from MySQL", () => {
    const [bucket, site, pg, my, other] = parseBlocks(`
resource "google_storage_bucket" "b" { name = "x" }
resource "google_storage_bucket" "s" {
  name = "y"
  website { main_page_suffix = "index.html" }
}
resource "google_sql_database_instance" "p" { database_version = "POSTGRES_15" }
resource "google_sql_database_instance" "m" { database_version = "MYSQL_8_0" }
resource "google_sql_database_instance" "o" { database_version = var.version }
`);
    assert.equal(resourceTypeToKind("google_storage_bucket", "gcp", bucket)?.kind, "object-storage");
    assert.equal(resourceTypeToKind("google_storage_bucket", "gcp", site)?.kind, "static-site");
    assert.equal(resourceTypeToKind("google_sql_database_instance", "gcp", pg)?.kind, "postgres");
    assert.equal(resourceTypeToKind("google_sql_database_instance", "gcp", my)?.kind, "mysql");
    // A version it cannot read is a database it cannot name: untranslated, never guessed.
    assert.equal(resourceTypeToKind("google_sql_database_instance", "gcp", other), null);
  });

  it("reads the version out of the database_version Google spells", () => {
    const pg = read('resource "google_sql_database_instance" "p" {\n  database_version = "POSTGRES_17"\n}');
    assert.deepEqual(pg.model.nodes.find((n) => n.kind === "postgres")?.attributes, { "PostgreSQL version": "PostgreSQL 17" });
    // A major past end of life is still a PostgreSQL instance, but not one the model can name a version for.
    const old = read('resource "google_sql_database_instance" "p" {\n  database_version = "POSTGRES_14"\n}');
    assert.equal(old.model.nodes.some((n) => n.kind === "postgres"), true);
    assert.equal(old.model.nodes.find((n) => n.kind === "postgres")?.attributes?.["PostgreSQL version"], undefined);
    const my = read('resource "google_sql_database_instance" "m" {\n  database_version = "MYSQL_8_4"\n}');
    assert.deepEqual(my.model.nodes.find((n) => n.kind === "mysql")?.attributes, { "MySQL version": "MySQL 8.4" });
  });

  it("reads the module calls of the Google registry modules", () => {
    assert.equal(moduleSourceToKind("terraform-google-modules/network/google")?.kind, "vnet");
    assert.equal(moduleSourceToKind("terraform-google-modules/pubsub/google")?.kind, "queue");
    assert.equal(moduleSourceToKind("GoogleCloudPlatform/sql-db/google//modules/postgresql"), null);
    const postgres = read(`
module "db" {
  source           = "GoogleCloudPlatform/sql-db/google//modules/postgresql"
  database_version = "POSTGRES_16"
}
`);
    assert.deepEqual(postgres.model.nodes.map((n) => n.kind), ["internet", "postgres"]);
    const module = read(`
module "net" {
  source  = "terraform-google-modules/network/google"
  version = "~> 12.0"
}
`);
    assert.equal(module.cloud, "gcp");
    assert.deepEqual(module.model.nodes.map((n) => n.kind), ["internet", "vnet"]);
  });

  it("reads and builds a kind from the same spec", () => {
    assert.equal(readSpec("queue", "gcp")?.type, "google_pubsub_topic");
    assert.equal(cloudSpec("queue", "gcp")?.type, "google_pubsub_topic");
    assert.equal(readSpec("queue", "aws")?.type, "aws_sqs_queue");
    assert.equal(readSpec("static-site", "gcp")?.type, "google_storage_bucket");
    assert.equal(cloudSpec("static-site", "gcp")?.type, "google_storage_bucket");
    // The nodes that are not components are not built on any cloud.
    assert.equal(cloudSpec("internet", "gcp"), null);
    assert.equal(cloudSpec("external", "gcp"), null);
  });
});

/** The blocks themselves, in file order, for the reverse map's block check. */
function parseBlocks(source: string) {
  return parseHcl(source);
}

describe("mixed-cloud files", () => {
  const AWS = `
resource "aws_sqs_queue" "jobs" { name = "jobs" }
resource "aws_s3_bucket" "data" { bucket = "x" }
resource "aws_dynamodb_table" "orders" { name = "o" }
`;
  const GOOGLE = `
resource "google_bigquery_dataset" "analytics" { dataset_id = "a" }
resource "google_pubsub_topic" "events" { name = "e" }
`;

  it("goes to the cloud most of its resources are on", () => {
    assert.equal(read(AWS + GOOGLE).cloud, "aws");
    const moreGoogle = `${GOOGLE}
resource "google_service_account" "a" { account_id = "a" }
resource "google_dns_managed_zone" "z" { name = "z" }
`;
    // Google Cloud is read only: it never outvotes a cloud Terragram generates for.
    assert.equal(read(AWS + moreGoogle).cloud, "aws");
    assert.equal(read(`${AWS}${moreGoogle}${moreGoogle.replaceAll('"a"', '"b"').replaceAll('"z"', '"y"')}`).cloud, "aws");
    assert.equal(read(`resource "azurerm_redis_cache" "c" {}\n${moreGoogle}`).cloud, "azure");
    assert.equal(read(moreGoogle).cloud, "gcp");
  });

  it("says what a file that has AWS in it leaves out of the Terraform, instead of nothing", () => {
    const mixed = read(`${AWS}resource "google_project" "p" { name = "p" project_id = "p" }
resource "google_service_account" "a" { account_id = "a" }
resource "google_dns_managed_zone" "z" { name = "z" }
`);
    assert.equal(mixed.cloud, "aws");
    const feasibility = assessFeasibility(mixed.model, mixed.cloud);
    assert.equal(feasibility.verdict, "partial");
    assert.deepEqual(feasibility.omitted, ["Project"]);
    assert.doesNotMatch(feasibility.summary, /nothing is left out/);
    const emitted = emitTerraform(mixed.model, mixed.cloud, "terraform");
    assert.ok(emitted.files.length > 0);
    assert.doesNotMatch(emitted.files.map((f) => f.content).join("\n"), /google_/);
  });

  it("breaks a tie toward Azure, then AWS, as it did before Google Cloud", () => {
    const queue = 'resource "aws_sqs_queue" "jobs" { name = "jobs" }';
    const topic = 'resource "google_pubsub_topic" "events" { name = "e" }';
    assert.equal(read(`${queue}\n${topic}`).cloud, "aws");
    assert.equal(read('resource "azurerm_redis_cache" "c" {}\nresource "google_pubsub_topic" "t" { name = "e" }').cloud, "azure");
  });

  it("keeps the components of the other cloud, as it does for AWS and Azure", () => {
    const mixed = read(AWS + GOOGLE);
    const kinds = mixed.model.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("data-warehouse"));
    assert.ok(kinds.includes("queue"));
    assert.ok(kinds.includes("object-storage"));
    assert.ok(kinds.includes("nosql"));
    assert.deepEqual(mixed.untranslated, []);
  });

  it("still refuses a file with nothing it can read, and says which clouds it reads", () => {
    const result = parseTerraform('resource "oci_objectstorage_bucket" "b" {\n  name = "x"\n}');
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /AWS, Azure and Google Cloud/);
  });

  it("does not mistake an AWS or Azure resource for a Google Cloud one", () => {
    assert.equal(read('resource "aws_sqs_queue" "q" { name = "q" }').cloud, "aws");
    assert.equal(read('resource "azurerm_redis_cache" "c" {}').cloud, "azure");
  });
});

describe("a Google Cloud model is read, drawn, explained and generated", () => {
  const { model } = read(FIXTURE);

  it("writes a plan on the google provider, from resources and no module", () => {
    const out = emitTerraform(model, "gcp");
    assert.equal(out.provider, "google");
    assert.match(out.providerVersion, /^~> \d+\.\d+$/);
    assert.deepEqual(out.modules, []);
    assert.equal(out.regionLabel, "London (europe-west2)");
    assert.deepEqual(out.files.slice(0, 3).map((f) => f.name), ["main.tf", "variables.tf", "outputs.tf"]);
    assert.match(out.files[0]?.content ?? "", /# Target: Google Cloud · London \(europe-west2\) · Terraform/);
  });

  it("builds every component of the fixture, and says so as it does for AWS and Azure", () => {
    const feasibility = assessFeasibility(model, "gcp");
    assert.equal(feasibility.verdict, "full");
    assert.deepEqual(feasibility.omitted, []);
    assert.equal(feasibility.summary, "All 19 components can be built on Google Cloud.");
  });

  it("is described in plain English as Google Cloud", () => {
    const text = explainModel(model, "gcp", "London (europe-west2)");
    assert.match(text, /^This design targets Google Cloud in London \(europe-west2\)\. It has 19 components/);
    assert.match(text, /Project/);
    assert.match(text, /Kubernetes Cluster/);
    assert.match(text, /Data Warehouse/);
  });

  it("has a receipt that verifies, with the plan hashed and the provider in its bill of materials", async () => {
    const built = await buildEvidenceReceipt(model, "gcp", "deterministic", "alice", "2026-11-27T00:00:00Z", { signer: testSigner() });
    assert.equal(built.receipt.cloud, "gcp");
    assert.deepEqual(built.receipt.plan.slice(0, 3), ["main.tf", "variables.tf", "outputs.tf"]);
    assert.ok(built.receipt.sbom.some((entry) => entry.name === "google"));
    assert.deepEqual(built.receipt.omitted, []);
    const files = buildBundle(built.receipt, model, built.terraform.files, built.attestation);
    const report = await verifyBundle(files, { trustedKeys: [built.receipt.publicKey ?? ""] });
    assert.equal(report.ok, true, JSON.stringify(report));
  });

  it("draws, with a golden", () => {
    golden("model.svg", `${modelToSvg(model)}\n`);
  });

  it("is a pull request diagram, with a golden", () => {
    const diagram = renderDiagram(diffModels({ nodes: [], edges: [], topology: "derived" }, model));
    assert.notEqual(diagram.mermaid, null);
    golden("diff.mmd", `${diagram.mermaid}\n`);
  });
});
