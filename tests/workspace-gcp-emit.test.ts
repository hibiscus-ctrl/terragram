// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { composeFromPrompt, detectCloud } from "terragram-engine/engine";
import { explainModel } from "terragram-engine/explain";
import { assessFeasibility } from "terragram-engine/feasibility";
import { addNode, connectNodes as addEdge, setNodeAttribute } from "terragram-engine/inspector";
import { EMPTY_MODEL, type InfraModel } from "terragram-engine/model";
import { parseHcl } from "terragram-engine/hcl";
import { fieldsForKind, isScaffoldResource } from "terragram-engine/kinds";
import { parseTerraform } from "terragram-engine/parse";
import { emitTerraform } from "terragram-engine/terraform";
import { skipsFor } from "../scripts/scanner-skips.ts";

/**
 * Google Cloud is generated like the other two: the plan around the resources (provider, labels, the
 * APIs it switches on, private service access) and what each kind writes. The fixture's own model is
 * the golden, so a change to any kind's output shows up as a diff a reviewer reads.
 */

const FIXTURE = readFileSync(new URL("./fixtures/gcp/main.tf", import.meta.url), "utf8");
const golden = (name: string) => new URL(`./fixtures/gcp/golden/emit/${name}`, import.meta.url);

function check(name: string, actual: string): void {
  const path = golden(name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path.pathname), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `${name} differs from its golden; UPDATE_GOLDEN=1 rewrites it`);
}

/** A model of the given kinds, added in order, each a node of its own. */
function modelOf(...kinds: string[]): { model: InfraModel; ids: string[] } {
  let model = EMPTY_MODEL;
  const ids: string[] = [];
  for (const kind of kinds) {
    const added = addNode(model, kind);
    assert.ok(added, kind);
    model = added.model;
    ids.push(added.id);
  }
  return { model, ids };
}

function plan(model: InfraModel): { main: string; variables: string; outputs: string; files: string[] } {
  const out = emitTerraform(model, "gcp");
  const read = (name: string) => out.files.find((f) => f.name === name)?.content ?? "";
  return { main: read("main.tf"), variables: read("variables.tf"), outputs: read("outputs.tf"), files: out.files.map((f) => f.name) };
}

describe("the Google Cloud plan generated from the fixture", () => {
  const parsed = parseTerraform(FIXTURE);
  assert.ok(parsed.ok);
  const out = emitTerraform(parsed.model, "gcp");

  for (const file of out.files) {
    it(`writes ${file.name}, with a golden`, () => {
      check(file.name.replaceAll("/", "__"), file.content);
    });
  }

  it("is the same every time", () => {
    assert.deepEqual(emitTerraform(parsed.model, "gcp").files, out.files);
  });

  it("reads back to the components it was written from, with none of the plan's own scaffolding drawn", () => {
    const main = out.files[0]?.content ?? "";
    const back = parseTerraform(main);
    assert.ok(back.ok);
    const kinds = back.model.nodes.filter((n) => n.kind !== "internet" && n.kind !== "external").map((n) => n.kind);
    assert.ok(back.untranslated.every((t) => !/^google_(project_service|storage_bucket_object)\./.test(t)), back.untranslated.join(", "));
    const wrote = parsed.model.nodes.filter((n) => n.kind !== "internet").map((n) => n.kind);
    // Everything the model drew that is built comes back; what the plan adds around it (API switches,
    // log and source buckets, the private service connection) does not.
    for (const kind of new Set(kinds)) assert.ok(wrote.includes(kind), `${kind} was not drawn`);
    assert.equal(kinds.filter((k) => k === "object-storage").length, 2, "one node per bucket the model drew, not per bucket the plan added");
    // The only other nodes are the ones a project-wide grant draws: the stand-ins for a principal and for "any resource".
    const others = back.model.nodes.filter((n) => n.kind === "external").map((n) => n.id);
    assert.ok(others.every((id) => id === "any-resource" || id.startsWith("principal-")), others.join(", "));
  });

  it("puts no secret in any file", () => {
    const text = out.files.map((f) => f.content).join("\n");
    assert.doesNotMatch(text, /\bpassword\b|private_key|secret_data|auth_string|client_secret/i);
    // Variables that name an account or an address are asked for, none holds a credential.
    assert.doesNotMatch(out.files.find((f) => f.name === "variables.tf")?.content ?? "", /sensitive/);
  });
});

describe("the plan around the resources", () => {
  const { model } = modelOf("postgres", "object-storage");
  const { main, variables } = plan(model);

  it("pins the provider and says which project and region it works in", () => {
    assert.match(main, /google = \{\n\s+source\s+= "hashicorp\/google"\n\s+version = "~> \d+\.\d+"/);
    assert.match(main, /provider "google" \{\n\s+project\s+= var\.project_id\n\s+region\s+= var\.region\n\s+default_labels = local\.labels/);
    assert.match(main, /required_version = ">= 1\.6, < 2\.0"/);
    assert.doesNotMatch(main, /google-beta|archive/);
  });

  it("asks for the project and gives the region, the prefix and the labels a default", () => {
    assert.match(variables, /variable "project_id" \{\n\s+type\s+= string\n\s+description = "[^"]+"\n\}/);
    assert.match(variables, /variable "region" \{[^}]*default\s+= "europe-west2"/);
    assert.match(variables, /variable "labels" \{[^}]*default\s+= \{\}/);
    assert.match(main, /labels = merge\(\{ managed_by = "diagram", environment = "dev" \}, var\.labels\)/);
  });

  it("names the environment from the model", () => {
    const chosen = setNodeAttribute(model, model.nodes.find((n) => n.kind === "postgres")?.id ?? "", "Environment", "Production");
    assert.match(plan(chosen).main, /environment = "production"/);
  });

  it("switches on exactly the APIs its components use, sorted, once", () => {
    const apis = /for_each\s+= toset\(\[([^\]]*)\]\)/.exec(main)?.[1] ?? "";
    assert.equal(
      apis,
      '"compute.googleapis.com", "servicenetworking.googleapis.com", "sqladmin.googleapis.com", "storage.googleapis.com"',
    );
    assert.equal(main.match(/resource "google_project_service" "enabled"/g)?.length, 1);
    assert.match(main, /disable_on_destroy = false/);
  });

  it("makes a resource that stands on nothing else wait for the APIs, and no other", () => {
    assert.match(main, /resource "google_storage_bucket" "object_storage" \{[\s\S]*?depends_on\s+= \[google_project_service\.enabled\]/);
    // The log bucket's grant stands on the log bucket, which already waits.
    const grant = /resource "google_storage_bucket_iam_member" "object_storage_logs_delivery" \{[^}]*\}/.exec(main)?.[0] ?? "";
    assert.doesNotMatch(grant, /depends_on/);
  });

  it("gives a plan with nothing in it a provider and no APIs", () => {
    const empty = plan(EMPTY_MODEL);
    assert.match(empty.main, /provider "google"/);
    assert.doesNotMatch(empty.main, /default_labels|google_project_service/);
  });
});

describe("a database or a cache reaches its network through private service access", () => {
  it("makes one range and one connection for the plan, however many ask", () => {
    const { main } = plan(modelOf("vnet", "postgres", "mysql", "redis-cache").model);
    assert.equal(main.match(/resource "google_service_networking_connection"/g)?.length, 1);
    assert.equal(main.match(/resource "google_compute_global_address" "private_services"/g)?.length, 1);
    assert.match(main, /network\s+= google_compute_network\.vnet\.id/);
    assert.match(main, /deletion_policy\s+= "ABANDON"/);
    for (const resource of ["google_sql_database_instance\" \"postgres", "google_sql_database_instance\" \"mysql", "google_redis_instance\" \"redis_cache"]) {
      assert.match(main, new RegExp(`resource "${resource}" \\{[\\s\\S]*?depends_on[^\\n]*google_service_networking_connection\\.private_services`));
    }
  });

  it("asks for a network when the model draws none, and says what it is for", () => {
    const { main, variables } = plan(modelOf("postgres").model);
    assert.match(main, /private_network\s+= var\.network_id/);
    assert.match(variables, /variable "network_id" \{\n\s+type\s+= string\n\s+description = "VPC network the resources are placed in\. Add a Virtual Network/);
    assert.doesNotMatch(variables, /variable "network_id" \{[^}]*default/);
  });

  it("is not drawn when the plan is read back", () => {
    const back = parseTerraform(plan(modelOf("vnet", "postgres").model).main);
    assert.ok(back.ok);
    assert.deepEqual(
      back.model.nodes.filter((n) => n.kind !== "internet" && n.kind !== "external").map((n) => n.kind).sort(),
      ["entra-id", "postgres", "vnet"],
    );
  });
});

describe("what each kind asks the reviewer for", () => {
  it("a database, a cache and a cluster ask for a network when there is none", () => {
    for (const kind of ["redis-cache", "kubernetes", "virtual-machine"]) {
      const { main, variables } = plan(modelOf(kind).model);
      assert.match(variables, /variable "network_id"/, kind);
      assert.match(main, /var\.network_id|var\.subnetwork_id/, kind);
    }
  });

  it("a cluster asks for the range that may reach its control plane, with no default, and refuses a wide one", () => {
    const { variables } = plan(modelOf("kubernetes").model);
    assert.match(variables, /variable "gke_authorized_cidr" \{\n\s+type\s+= string\n\s+description = "[^"]+"\n\n\s+validation \{/);
    assert.doesNotMatch(variables, /variable "gke_authorized_cidr" \{[^}]*default/);
    // A /24 or narrower, and never a block that starts at 0.
    assert.match(variables, /condition\s+= can\(cidrhost\(var\.gke_authorized_cidr, 0\)\) && try\(tonumber\(split\("\/", var\.gke_authorized_cidr\)\[1\]\) >= 24, false\) && !startswith\(var\.gke_authorized_cidr, "0\."\)/);
  });

  it("a cluster's control plane admits the one range it was given, not Google's public ranges", () => {
    const { main } = plan(modelOf("kubernetes").model);
    const cluster = /resource "google_container_cluster" "kubernetes" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    assert.match(cluster, /master_authorized_networks_config \{\n\s+gcp_public_cidrs_access_enabled = false\n\s+cidr_blocks \{\n\s+cidr_block\s+= var\.gke_authorized_cidr/);
    assert.match(cluster, /enable_private_nodes\s+= true/);
  });

  it("a cluster removes the node pool it is created with, as the provider documents, and runs its own", () => {
    const { main } = plan(modelOf("kubernetes").model);
    const cluster = /resource "google_container_cluster" "kubernetes" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    assert.match(cluster, /remove_default_node_pool\s+= true/);
    assert.match(cluster, /initial_node_count\s+= 1\n/);
    assert.match(main, /resource "google_container_node_pool" "kubernetes_nodes"/);
  });

  it("each cluster takes a control-plane range of its own, which the reviewer can change within private space", () => {
    const { main, variables } = plan(modelOf("kubernetes", "kubernetes", "kubernetes").model);
    const ranges = [...main.matchAll(/master_ipv4_cidr_block\s+= var\.([a-z0-9_]+)/g)].map((m) => m[1] ?? "");
    assert.deepEqual(ranges, ["kubernetes_master_cidr", "kubernetes_2_master_cidr", "kubernetes_3_master_cidr"]);
    const defaults = ranges.map((name) => new RegExp(`variable "${name}" \\{[^}]*default\\s+= "([^"]+)"`).exec(variables)?.[1]);
    assert.deepEqual(defaults, ["172.16.0.0/28", "172.16.0.16/28", "172.16.0.32/28"]);
    for (const name of ranges) {
      assert.match(variables, new RegExp(`variable "${name}" \\{[\\s\\S]*?validation \\{\\n\\s+condition\\s+= can\\(cidrhost\\(var\\.${name}, 0\\)\\) && endswith\\(var\\.${name}, "/28"\\)`));
    }
    // One authorised range is shared; the control-plane ranges are not.
    assert.equal(variables.match(/variable "gke_authorized_cidr"/g)?.length, 1);
  });

  it("a project asks for its billing account and its organisation, never a password or a key", () => {
    const { main, variables } = plan(modelOf("project").model);
    assert.match(variables, /variable "billing_account" \{\n\s+type\s+= string\n\s+description = "[^"]+"\n\}/);
    assert.match(variables, /variable "org_id" \{[^}]*default\s+= null/);
    assert.match(main, /auto_create_network\s+= false/);
    assert.match(main, /resource "google_project_iam_audit_config" "project"/);
    // The project is where the APIs are enabled, and does not wait for them.
    assert.match(main, /resource "google_project_service" "enabled" \{[^}]*project\s+= google_project\.project\.project_id/);
    assert.doesNotMatch(/resource "google_project" "project" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "", /depends_on/);
  });

  it("monitoring asks where alerts go", () => {
    const { main, variables } = plan(modelOf("monitoring").model);
    assert.match(variables, /variable "alert_email"/);
    assert.match(main, /email_address = var\.alert_email/);
    assert.match(main, /retention_days\s+= 30/);
    const year = setNodeAttribute(modelOf("monitoring").model, "monitoring", "Log retention", "1 year");
    assert.match(plan(year).main, /retention_days\s+= 365/);
  });
});

describe("choices the reviewer makes in the inspector reach the plan", () => {
  const choose = (kind: string, key: string, value: string) => {
    const { model, ids } = modelOf(kind);
    return plan(setNodeAttribute(model, ids[0] ?? "", key, value)).main;
  };

  it("the PostgreSQL and MySQL versions", () => {
    for (const major of ["15", "17", "18"]) {
      assert.match(choose("postgres", "PostgreSQL version", `PostgreSQL ${major}`), new RegExp(`database_version\\s+= "POSTGRES_${major}"`));
    }
    assert.match(plan(modelOf("postgres").model).main, /database_version\s+= "POSTGRES_16"/);
    assert.match(plan(modelOf("mysql").model).main, /database_version\s+= "MYSQL_8_4"/);
  });

  it("offers no database version that has reached end of life", () => {
    const offered = (kind: string) => fieldsForKind(kind).find((f) => f.options && /version/.test(f.key))?.options ?? [];
    assert.deepEqual(offered("postgres"), ["PostgreSQL 18", "PostgreSQL 17", "PostgreSQL 16", "PostgreSQL 15"]);
    assert.deepEqual(offered("mysql"), ["MySQL 8.4"]);
    // A value an older model carries is not written: the plan falls back to the default instead of a version Google no longer supports.
    assert.match(choose("postgres", "PostgreSQL version", "PostgreSQL 14"), /database_version\s+= "POSTGRES_16"/);
    assert.match(choose("mysql", "MySQL version", "MySQL 5.7"), /database_version\s+= "MYSQL_8_4"/);
    assert.doesNotMatch(choose("mysql", "MySQL version", "MySQL 8.0"), /MYSQL_8_0/);
  });

  it("the cache's size", () => {
    assert.match(choose("redis-cache", "Cache SKU", "Basic (C0)"), /tier\s+= "BASIC"[\s\S]*memory_size_gb\s+= 1/);
    assert.match(choose("redis-cache", "Cache SKU", "Premium (P1)"), /tier\s+= "STANDARD_HA"[\s\S]*memory_size_gb\s+= 5/);
  });

  it("the container's size", () => {
    assert.match(choose("containers", "Container size", "Small (0.5 vCPU)"), /cpu\s+= "500m"[\s\S]*memory = "512Mi"/);
    assert.match(choose("containers", "Container size", "Large (2 vCPU)"), /cpu\s+= "2000m"[\s\S]*memory = "2Gi"/);
  });

  it("the function's runtime, with a source file written beside the plan for each", () => {
    const cases: Array<[string, RegExp, string]> = [
      ["Node.js 22", /runtime\s+= "nodejs22"/, "src/functions/index.js"],
      ["Python 3.12", /runtime\s+= "python312"/, "src/functions/main.py"],
      ["Java 21", /runtime\s+= "java21"[\s\S]*entry_point\s+= "example\.Handler"/, "src/functions/src/main/java/example/Handler.java"],
    ];
    for (const [label, runtime, file] of cases) {
      const { model, ids } = modelOf("functions");
      const out = plan(setNodeAttribute(model, ids[0] ?? "", "Runtime", label));
      assert.match(out.main, runtime, label);
      assert.ok(out.files.includes(file), `${label}: ${out.files.join(", ")}`);
    }
    assert.match(plan(modelOf("functions").model).main, /source_dir\s+= "\$\{path\.module\}\/src\/functions"/);
  });

  it("the delivery guarantee of a queue", () => {
    assert.match(choose("queue", "Delivery", "Exactly once (FIFO)"), /enable_exactly_once_delivery\s+= true/);
    assert.match(plan(modelOf("queue").model).main, /enable_exactly_once_delivery\s+= false/);
  });

  it("the address space of the network", () => {
    const main = choose("vnet", "Address space", "192.168.0.0/16");
    assert.match(main, /ip_cidr_range\s+= cidrsubnet\("192\.168\.0\.0\/16", 8, 1\)/);
    assert.match(main, /source_ranges\s+= \[google_compute_subnetwork\.vnet\.ip_cidr_range\]/);
  });

  it("the network's rule for its own traffic is sourced from the subnetwork, never from the address space as typed", () => {
    const { main } = plan(modelOf("vnet").model);
    const rule = /resource "google_compute_firewall" "vnet_internal" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    assert.match(rule, /source_ranges\s+= \[google_compute_subnetwork\.vnet\.ip_cidr_range\]/);
    assert.doesNotMatch(rule, /0\.0\.0\.0|"\d+\.\d+/);
    // The one other rule admits Identity-Aware Proxy's range alone.
    assert.match(main, /source_ranges\s+= \["35\.235\.240\.0\/20"\]/);
  });

  it("refuses an address space on Google Cloud that is not private, before any rule is written from it", () => {
    for (const space of ["0.0.0.0/0", "8.8.8.0/24", "11.0.0.0/16", "10.0.0.0/7", "172.32.0.0/16", "172.15.0.0/16", "172.16.0.0/11", "192.168.0.0/15", "192.169.0.0/16", "100.64.0.0/9", "100.128.0.0/16"]) {
      const { model, ids } = modelOf("vnet");
      const chosen = setNodeAttribute(model, ids[0] ?? "", "Address space", space);
      assert.throws(() => emitTerraform(chosen, "gcp"), /is not a private address range/, space);
    }
    for (const space of ["10.0.0.0/8", "10.20.0.0/16", "172.16.0.0/12", "172.31.0.0/16", "192.168.0.0/16", "192.168.4.0/24", "100.64.0.0/10", "100.64.0.0/16", "100.127.255.0/24"]) {
      const { model, ids } = modelOf("vnet");
      const main = plan(setNodeAttribute(model, ids[0] ?? "", "Address space", space)).main;
      assert.match(main, new RegExp(`cidrsubnet\\("${space.replace(/[./]/g, "\\$&")}", 8, 1\\)`), space);
    }
  });

  it("takes carrier-grade NAT space on AWS and Azure too, and any block there short of the internet", () => {
    for (const space of ["100.64.0.0/16", "100.64.0.0/10"]) {
      const { model, ids } = modelOf("vnet");
      const chosen = setNodeAttribute(model, ids[0] ?? "", "Address space", space);
      assert.match(emitTerraform(chosen, "aws").files[0]?.content ?? "", new RegExp(`cidr\\s+= "${space.replace(/[./]/g, "\\$&")}"`), `aws ${space}`);
      assert.match(emitTerraform(chosen, "azure").files[0]?.content ?? "", new RegExp(`address_space\\s+= \\["${space.replace(/[./]/g, "\\$&")}"\\]`), `azure ${space}`);
    }
    // What was accepted before on those two stays accepted: a block that is not RFC 1918, down to a /8.
    for (const space of ["8.8.8.0/24", "11.0.0.0/16", "172.32.0.0/16", "9.0.0.0/8"]) {
      const { model, ids } = modelOf("vnet");
      const chosen = setNodeAttribute(model, ids[0] ?? "", "Address space", space);
      for (const cloud of ["aws", "azure"] as const) assert.doesNotThrow(() => emitTerraform(chosen, cloud), `${cloud} ${space}`);
    }
    // The internet, and anything wider than a /8, never is.
    for (const space of ["0.0.0.0/0", "0.0.0.0/7", "10.0.0.0/7", "100.64.0.0/2"]) {
      const { model, ids } = modelOf("vnet");
      const chosen = setNodeAttribute(model, ids[0] ?? "", "Address space", space);
      for (const cloud of ["aws", "azure"] as const) assert.throws(() => emitTerraform(chosen, cloud), /is wider than a \/8/, `${cloud} ${space}`);
    }
  });

  it("the name of the zone", () => {
    assert.match(choose("dns", "Zone name", "example.org"), /dns_name\s+= "example\.org\."/);
  });
});

describe("a function is packaged from the plan's own directory", () => {
  const { main } = plan(modelOf("functions").model);

  it("declares the archive provider for it, and only then", () => {
    assert.match(main, /archive = \{\n\s+source\s+= "hashicorp\/archive"/);
    assert.doesNotMatch(plan(modelOf("queue").model).main, /archive/);
  });

  it("keeps the source in a private bucket of its own and the function on its own service account", () => {
    assert.match(main, /resource "google_storage_bucket" "functions_source" \{[\s\S]*?labels\s+= \{\n\s+purpose = "function-source"/);
    assert.match(main, /service_account_email\s+= google_service_account\.functions\.email/);
  });

  it("is not drawn as a bucket or a data source of its own", () => {
    const back = parseTerraform(main);
    assert.ok(back.ok);
    assert.deepEqual(back.model.nodes.filter((n) => n.kind !== "external").map((n) => n.kind).sort(), ["entra-id", "functions", "internet"]);
  });
});

describe("a bucket wired to the plan, and a service wired to its dependencies", () => {
  it("a container is given its database's address as an environment variable", () => {
    const { model, ids } = modelOf("containers", "postgres");
    const wired = addEdge(model, ids[0] ?? "", ids[1] ?? "");
    const { main } = plan(wired);
    assert.match(main, /env \{\n\s+name\s+= "DATABASE_HOST"\n\s+value = google_sql_database_instance\.postgres\.private_ip_address/);
  });

  it("a function is given its queue and its bucket in its environment", () => {
    const { model, ids } = modelOf("functions", "queue", "object-storage");
    const wired = addEdge(addEdge(model, ids[0] ?? "", ids[1] ?? ""), ids[0] ?? "", ids[2] ?? "");
    const { main } = plan(wired);
    assert.match(main, /environment_variables = \{[^}]*PUBSUB_TOPIC\s+= google_pubsub_topic\.queue\.id/);
    assert.match(main, /STORAGE_BUCKET\s+= google_storage_bucket\.object_storage\.name/);
  });

  it("a bucket wired to the key store is encrypted under its key, and the service agent may use it", () => {
    const { model, ids } = modelOf("object-storage", "key-vault");
    const { main } = plan(addEdge(model, ids[0] ?? "", ids[1] ?? ""));
    assert.match(main, /resource "google_storage_bucket" "object_storage" \{[\s\S]*?encryption \{\n\s+default_kms_key_name = google_kms_crypto_key\.key_vault\.id/);
    assert.match(main, /member\s+= "serviceAccount:\$\{data\.google_storage_project_service_account\.object_storage_to_key_vault\.email_address\}"/);
    assert.match(main, /depends_on\s+= \[[^\]]*google_kms_crypto_key_iam_member\.object_storage_to_key_vault/);
    // Not every bucket: the one with nothing wired to it stays on Google's own key.
    assert.doesNotMatch(plan(modelOf("object-storage").model).main, /default_kms_key_name/);
  });

  it("a plan with a key store encrypts every bucket, topic and dataset under its key, with one grant per service agent", () => {
    const { main } = plan(modelOf("key-vault", "object-storage", "functions", "queue", "data-warehouse").model);
    const buckets = main.match(/resource "google_storage_bucket" "[a-z_]+" \{[\s\S]*?\n\}/g) ?? [];
    // The bucket the model drew, its access-log bucket and the function's source bucket and its log bucket.
    assert.equal(buckets.length, 4);
    for (const bucket of buckets) {
      assert.match(bucket, /encryption \{\n\s+default_kms_key_name = google_kms_crypto_key\.key_vault\.id\n\s+\}/);
      assert.match(bucket, /depends_on\s+= \[[^\]]*google_kms_crypto_key_iam_member\.key_vault_storage/);
    }
    const topics = main.match(/resource "google_pubsub_topic" "[a-z_]+" \{[\s\S]*?\n\}/g) ?? [];
    assert.equal(topics.length, 2, "the queue and its dead-letter topic");
    for (const topic of topics) {
      assert.match(topic, /kms_key_name\s+= google_kms_crypto_key\.key_vault\.id/);
      assert.match(topic, /depends_on\s+= \[[^\]]*google_kms_crypto_key_iam_member\.key_vault_pubsub/);
    }
    const dataset = /resource "google_bigquery_dataset" "data_warehouse" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
    assert.match(dataset, /default_encryption_configuration \{\n\s+kms_key_name = google_kms_crypto_key\.key_vault\.id/);
    assert.match(dataset, /depends_on\s+= \[[^\]]*google_kms_crypto_key_iam_member\.key_vault_bigquery/);
    // Each service's own agent, and no other, may use the key.
    for (const [service, agent] of [
      ["storage", "data.google_storage_project_service_account.key_vault_storage.email_address"],
      ["pubsub", "google_project_service_identity.key_vault_pubsub.email"],
      ["bigquery", "data.google_bigquery_default_service_account.key_vault_bigquery.email"],
    ] as const) {
      const grant = new RegExp(`resource "google_kms_crypto_key_iam_member" "key_vault_${service}" \\{\\n\\s+crypto_key_id = google_kms_crypto_key\\.key_vault\\.id\\n\\s+role\\s+= "roles/cloudkms\\.cryptoKeyEncrypterDecrypter"\\n\\s+member\\s+= "serviceAccount:\\$\\{${agent.replace(/\./g, "\\.")}\\}"`);
      assert.match(main, grant, service);
    }
    // The agents are looked up (or made) after the APIs are on, and the Pub/Sub identity needs the beta provider.
    assert.match(main, /resource "google_project_service_identity" "key_vault_pubsub" \{\n\s+provider\s+= google-beta\n\s+service\s+= "pubsub\.googleapis\.com"\n\s+depends_on\s+= \[google_project_service\.enabled\]/);
    assert.match(main, /data "google_storage_project_service_account" "key_vault_storage" \{\n\s+depends_on\s+= \[google_project_service\.enabled\]/);
    assert.match(main, /data "google_bigquery_default_service_account" "key_vault_bigquery" \{\n\s+depends_on\s+= \[google_project_service\.enabled\]/);
  });

  it("writes only the grants the plan needs, and none at all without a key store", () => {
    const { main } = plan(modelOf("key-vault", "queue").model);
    assert.match(main, /google_kms_crypto_key_iam_member" "key_vault_pubsub"/);
    assert.doesNotMatch(main, /key_vault_storage|key_vault_bigquery/);
    const bare = plan(modelOf("object-storage", "queue", "data-warehouse").model).main;
    assert.doesNotMatch(bare, /kms_key_name|default_encryption_configuration|default_kms_key_name|google_kms/);
  });

  it("one grant per agent when an edge already wired a bucket to the key, not two over the same binding", () => {
    const { model, ids } = modelOf("object-storage", "key-vault");
    const { main } = plan(addEdge(model, ids[0] ?? "", ids[1] ?? ""));
    const storageGrants = main.match(/resource "google_kms_crypto_key_iam_member" "[a-z_]+" \{[^}]*google_storage_project_service_account[^}]*\}/g) ?? [];
    assert.equal(storageGrants.length, 1);
    // Its log bucket is under the key as well, waiting for that one grant.
    assert.match(main, /resource "google_storage_bucket" "object_storage_logs" \{[\s\S]*?depends_on\s+= \[[^\]]*google_kms_crypto_key_iam_member\.object_storage_to_key_vault/);
  });

  it("reads back with no more components than were drawn, the plan's buckets and agent lookups hidden", () => {
    const back = parseTerraform(plan(modelOf("key-vault", "object-storage", "functions", "queue", "data-warehouse").model).main);
    assert.ok(back.ok);
    assert.deepEqual(
      [...new Set(back.model.nodes.filter((n) => n.kind !== "external" && n.kind !== "internet").map((n) => n.kind))].sort(),
      ["data-warehouse", "entra-id", "functions", "key-vault", "object-storage", "queue"],
    );
    assert.equal(back.model.nodes.filter((n) => n.kind === "object-storage").length, 1, "the log and source buckets are not drawn, encrypted or not");
    assert.deepEqual(back.untranslated.filter((t) => t.startsWith("data.")), []);
  });

  it("holds a plan with a key store to the encryption rules, and a plan without one to the reviewed exceptions", () => {
    const rules = [["checkov", "CKV_GCP_83"], ["checkov", "CKV_GCP_81"], ["trivy", "GCP-0066"]] as const;
    const without = new Set(["queue", "object-storage"]);
    const withStore = new Set(["queue", "object-storage", "key-vault"]);
    for (const [tool, id] of rules) {
      const named = (kinds: ReadonlySet<string>) => skipsFor(tool, kinds).some((skip) => skip[tool] === id);
      assert.equal(named(without), true, `${id} is skipped without a key store`);
      assert.equal(named(withStore), false, `${id} is enforced with one`);
    }
  });

  it("a DNS zone publishes a record for the tier behind it", () => {
    const { model, ids } = modelOf("dns", "containers");
    const { main } = plan(addEdge(model, ids[0] ?? "", ids[1] ?? ""));
    assert.match(main, /resource "google_dns_record_set" "dns_to_containers" \{/);
    assert.match(main, /managed_zone\s+= google_dns_managed_zone\.dns\.name/);
    assert.match(main, /name\s+= "www\.\$\{google_dns_managed_zone\.dns\.dns_name\}"/);
    assert.match(main, /type\s+= "CNAME"/);
    assert.match(main, /rrdatas\s+= \["\$\{trimprefix\(google_cloud_run_v2_service\.containers\.uri, "https:\/\/"\)\}\."\]/);
  });

  it("anything else is an explicit dependency", () => {
    const { model, ids } = modelOf("virtual-machine", "key-vault");
    const { main } = plan(addEdge(model, ids[0] ?? "", ids[1] ?? ""));
    assert.match(main, /depends_on\s+= \[google_project_service\.enabled, google_secret_manager_secret\.key_vault\]|depends_on\s+= \[google_secret_manager_secret\.key_vault/);
  });
});

describe("a Google Cloud brief", () => {
  it("is recognised by the services it names", () => {
    assert.equal(detectCloud("A GKE cluster with Cloud SQL"), "gcp");
    assert.equal(detectCloud("Deploy to Google Cloud"), "gcp");
    assert.equal(detectCloud("Move from Azure to GCP"), "gcp");
    assert.equal(detectCloud("Move from GCP to Azure"), "azure");
    assert.equal(detectCloud("Move our Azure app and AWS Lambda to Google Cloud"), "gcp");
  });

  it("composes and generates", () => {
    const composed = composeFromPrompt("A containerised API with a Postgres database, on Google Cloud");
    assert.equal(composed.cloud, "gcp");
    assert.match(composed.reply, /targeting Google Cloud/);
    const { main } = plan(composed.model);
    assert.match(main, /resource "google_cloud_run_v2_service"/);
    assert.match(main, /resource "google_sql_database_instance"/);
  });

  it("is explained and judged buildable by the same rules as the other two", () => {
    const { model } = modelOf("postgres", "containers", "project", "kubernetes");
    assert.equal(assessFeasibility(model, "gcp").verdict, "full");
    assert.match(explainModel(model, "gcp", "London (europe-west2)"), /^This design targets Google Cloud in London/);
    // A kind only Google Cloud has is left out, and said so, on the other two.
    const aws = assessFeasibility(model, "aws");
    assert.equal(aws.verdict, "partial");
    assert.deepEqual(aws.omitted, ["Project", "Kubernetes Cluster"]);
  });
});

describe("only what the generator writes is hidden as scaffolding", () => {
  /** The bucket a plan adds to log another's access, as written, and the bucket it logs. */
  const LOGS = `resource "google_storage_bucket" "logs" {
  name                        = "\${var.project_id}-logs-\${var.name_prefix}-data"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  labels                      = { purpose = "access-logs" }
}
`;
  const DATA = `resource "google_storage_bucket" "data" {
  name     = "data"
  location = "EU"

  logging {
    log_bucket = google_storage_bucket.logs.name
  }
}
`;
  const grant = (role: string, member: string, bucket = "logs") => `resource "google_storage_bucket_iam_member" "logs_delivery" {
  bucket = google_storage_bucket.${bucket}.name
  role   = "${role}"
  member = "${member}"
}
`;
  /** Whether the block is hidden; a block the file does not have is not. */
  const scaffold = (source: string, type: string, name: string) => {
    const blocks = parseHcl(source);
    const found = blocks.find((b) => b.labels[0] === type && b.labels[1] === name);
    return found !== undefined && isScaffoldResource(found, blocks);
  };
  const buckets = (source: string) => {
    const parsed = parseTerraform(source);
    assert.ok(parsed.ok);
    return parsed.model.nodes.filter((n) => n.kind === "object-storage" || n.kind === "static-site").length;
  };

  it("hides the log bucket of a bucket, and the grant that lets Cloud Storage write to it", () => {
    const source = `${DATA}${LOGS}${grant("roles/storage.objectCreator", "group:cloud-storage-analytics@google.com")}`;
    assert.equal(scaffold(source, "google_storage_bucket", "logs"), true);
    assert.equal(scaffold(source, "google_storage_bucket_iam_member", "logs_delivery"), true);
    assert.equal(scaffold(source, "google_storage_bucket", "data"), false);
    assert.equal(buckets(source), 1);
  });

  it("draws a bucket that only carries the label, or is named like one, when nothing logs into it", () => {
    assert.equal(scaffold(LOGS, "google_storage_bucket", "logs"), false);
    assert.equal(buckets(LOGS), 1);
    const named = `resource "google_storage_bucket" "app_source" {\n  name = "app"\n  location = "EU"\n}\n`;
    assert.equal(buckets(named), 1);
    assert.equal(buckets(`${named.replace("app_source", "app_logs")}`), 1);
  });

  it("draws a lookalike log bucket that differs in anything it writes", () => {
    const loosened = [
      LOGS.replace('"enforced"', '"inherited"'),
      LOGS.replace("uniform_bucket_level_access = true", "uniform_bucket_level_access = false"),
      LOGS.replace('{ purpose = "access-logs" }', '{ purpose = "access-logs", team = "x" }'),
      LOGS.replace('{ purpose = "access-logs" }', '{ purpose = "something-else" }'),
      LOGS.replace('"${var.project_id}-logs-', '"public-logs-'),
      LOGS.replace(/\}\n$/, '  website { main_page_suffix = "index.html" }\n}\n'),
      LOGS.replace(/\}\n$/, '  cors { origin = ["*"] }\n}\n'),
      LOGS.replace(/\}\n$/, "  extra = true\n}\n"),
    ];
    for (const logs of loosened) {
      assert.equal(scaffold(`${DATA}${logs}`, "google_storage_bucket", "logs"), false, logs);
      assert.equal(buckets(`${DATA}${logs}`), 2, logs);
    }
  });

  it("never hides a grant to anyone but Cloud Storage's own group, however the bucket is labelled", () => {
    for (const [role, member] of [
      ["roles/storage.objectCreator", "allUsers"],
      ["roles/storage.objectViewer", "allUsers"],
      ["roles/storage.objectViewer", "allAuthenticatedUsers"],
      ["roles/storage.objectCreator", "user:someone@example.com"],
      ["roles/storage.objectCreator", "group:other@example.com"],
      ["roles/storage.objectViewer", "group:cloud-storage-analytics@google.com"],
      ["roles/storage.objectAdmin", "group:cloud-storage-analytics@google.com"],
    ] as const) {
      const source = `${DATA}${LOGS}${grant(role, member)}`;
      assert.equal(scaffold(source, "google_storage_bucket_iam_member", "logs_delivery"), false, `${role} ${member}`);
    }
    // The exact grant, but on a bucket that is not one the plan added: it is the file's own grant.
    const onData = `${DATA}${LOGS}${grant("roles/storage.objectCreator", "group:cloud-storage-analytics@google.com", "data")}`;
    assert.equal(scaffold(onData, "google_storage_bucket_iam_member", "logs_delivery"), false);
    // And the grant still shows as access: a public read of a bucket is an edge from anyone on the internet.
    const parsed = parseTerraform(`${DATA}${LOGS}${grant("roles/storage.objectViewer", "allUsers", "data")}`);
    assert.ok(parsed.ok);
    assert.ok(parsed.model.edges.some((e) => e.source === "principal-public" || e.source.startsWith("principal-")), JSON.stringify(parsed.model.edges));
  });

  it("hides an archive, an uploaded object and the API switch only in the shape the generator writes them", () => {
    const archive = (extra = "") => `data "archive_file" "fn" {
  type        = "zip"
  source_dir  = "\${path.module}/src/fn"
  output_path = "\${path.module}/.terraform/fn.zip"
${extra}}
`;
    const blocks = (source: string) => parseHcl(source);
    assert.equal(isScaffoldResource(blocks(archive())[0] as never, blocks(archive())), true);
    for (const odd of [archive("  excludes = []\n"), archive().replace("/src/fn", "/../../etc"), archive().replace('"zip"', '"tar"')]) {
      assert.equal(isScaffoldResource(blocks(odd)[0] as never, blocks(odd)), false, odd);
    }
    const service = (extra = "", each = '["a.googleapis.com", "b.googleapis.com"]') =>
      `resource "google_project_service" "enabled" {\n  for_each = toset(${each})\n  service = each.value\n  disable_on_destroy = false\n${extra}}\n`;
    const project = 'resource "google_project" "p" {\n  name = "p"\n  project_id = "p"\n}\n';
    assert.equal(scaffold(service(), "google_project_service", "enabled"), true);
    assert.equal(scaffold(`${project}${service("  project = google_project.p.project_id\n")}`, "google_project_service", "enabled"), true);
    for (const [label, odd] of [
      ["a service that is not each.value", service().replace("each.value", '"iam.googleapis.com"')],
      ["a project of its own", service('  project = "someone-elses"\n')],
      ["a project that is not in the file", service("  project = google_project.gone.project_id\n")],
      ["an extra argument", service("  count = 1\n")],
      ["an extra block", service().replace(/\}\n$/, "  lifecycle {}\n}\n")],
      ["a variable list", service("", "var.apis")],
      ["a list with something that is not an API", service("", '["a.googleapis.com", "evil.example.com"]')],
      ["an empty list", service("", "[]")],
      ["a list with an expression", service("", '["a.googleapis.com", var.extra]')],
      ["disable_on_destroy true", service().replace("= false", "= true")],
    ] as const) {
      assert.equal(scaffold(odd, "google_project_service", "enabled"), false, label);
    }

    assert.equal(scaffold(service().replace("enabled", "mine"), "google_project_service", "mine"), false, "another name");

    // The private services range and connection, in use by an instance on their network, and every near miss.
    const range = (extra = "") => `resource "google_compute_global_address" "private_services" {
  name          = "r"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.n.id
${extra}}
`;
    const connection = (extra = "") => `resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.n.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
  deletion_policy         = "ABANDON"
${extra}}
`;
    const database = (network = "google_compute_network.n.id", waits = "[google_service_networking_connection.private_services]") => `resource "google_sql_database_instance" "db" {
  name       = "db"
  depends_on = ${waits}

  settings {
    tier = "db-custom-1-3840"

    ip_configuration {
      private_network = ${network}
    }
  }
}
`;
    const cache = `resource "google_redis_instance" "c" {
  name               = "c"
  authorized_network = google_compute_network.n.id
  depends_on         = [google_service_networking_connection.private_services]
}
`;
    const used = `${range()}${connection()}${database()}`;
    assert.equal(scaffold(used, "google_compute_global_address", "private_services"), true);
    assert.equal(scaffold(used, "google_service_networking_connection", "private_services"), true);
    assert.equal(scaffold(`${range()}${connection()}${cache}`, "google_service_networking_connection", "private_services"), true);
    for (const [label, source] of [
      ["no instance uses them", `${range()}${connection()}`],
      ["the instance is on another network", `${range()}${connection()}${database("google_compute_network.other.id")}`],
      ["the instance does not wait for the connection", `${range()}${connection()}${database(undefined, "[]")}`],
      ["the range alone", `${range()}${database()}`],
      ["the connection alone", `${connection()}${database()}`],
      ["the range has an extra argument", `${range('  description = "mine"\n')}${connection()}${database()}`],
      ["the connection has an extra argument", `${range()}${connection('  update_on_create_only = true\n')}${database()}`],
      ["the connection names another range", `${range()}${connection().replace("[google_compute_global_address.private_services.name]", '["theirs"]')}${database()}`],
      ["the connection is to another service", `${range()}${connection().replace("servicenetworking.googleapis.com", "other.googleapis.com")}${database()}`],
      ["the range is on another network", `${range().replace("n.id", "x.id")}${connection()}${database()}`],
      ["the range is not for peering", `${range().replace("VPC_PEERING", "PRIVATE_SERVICE_CONNECT")}${connection()}${database()}`],
    ] as const) {
      assert.equal(scaffold(source, "google_service_networking_connection", "private_services"), false, `connection: ${label}`);
      assert.equal(scaffold(source, "google_compute_global_address", "private_services"), false, `range: ${label}`);
    }
    assert.equal(scaffold(used.replace("address\" \"private_services\"", "address\" \"mine\""), "google_compute_global_address", "mine"), false);
  });

  it("hides nothing in what a plan generates that a reviewer would need to see: every scaffold block is accounted for", () => {
    const { model } = modelOf("object-storage", "functions", "postgres", "vnet");
    const blocks = parseHcl(plan(model).main);
    const hidden = blocks.filter((b) => isScaffoldResource(b, blocks)).map((b) => `${b.labels[0]}.${b.labels[1]}`);
    assert.deepEqual(hidden.sort(), [
      "data.archive_file.functions",
      "google_compute_global_address.private_services",
      "google_project_service.enabled",
      "google_service_networking_connection.private_services",
      "google_storage_bucket.functions_source",
      "google_storage_bucket.functions_source_logs",
      "google_storage_bucket.object_storage_logs",
      "google_storage_bucket_iam_member.functions_source_logs_delivery",
      "google_storage_bucket_iam_member.object_storage_logs_delivery",
      "google_storage_bucket_object.functions_source",
    ].map((a) => a.replace(/^data\./, "")).sort());
  });
});
