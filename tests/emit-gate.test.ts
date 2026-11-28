// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleModel, composeFromPrompt } from "terragram-engine/engine";
import { KIND_DEFINITIONS } from "terragram-engine/kinds";
import { emitTerraform } from "terragram-engine/terraform";
import { templateModel, WORKSPACE_TEMPLATES } from "terragram-engine/templates";
import { BRIEFS } from "../scripts/emit-briefs.ts";
import { GCP_PLANS } from "../scripts/emit-plans.ts";

/**
 * `scripts/validate-emit.ts` runs the real toolchain over what these lists generate, so what the lists
 * leave out is never validated or scanned. These hold that every Google Cloud kind is in the gate, and
 * that the paths a reviewer asked about (GKE, BigQuery, the key store's Pub/Sub and bucket encryption) are
 * in what it reads.
 */

const main = (plan: (typeof GCP_PLANS)[number]): string =>
  emitTerraform(assembleModel(plan.kinds, undefined, true).model, "gcp").files.map((f) => f.content).join("\n");

/** One resource block's text. */
function resourceText(text: string, type: string, name: string): string {
  const start = text.indexOf(`resource "${type}" "${name}" {`);
  assert.notEqual(start, -1, `${type}.${name}`);
  return text.slice(start, text.indexOf("\n}\n", start));
}

describe("the emit gate's Google Cloud documents", () => {
  const gateKinds = new Set<string>();
  for (const brief of BRIEFS) for (const n of composeFromPrompt(brief).model.nodes) gateKinds.add(n.kind);
  for (const template of WORKSPACE_TEMPLATES) for (const n of templateModel(template).nodes) gateKinds.add(n.kind);
  for (const plan of GCP_PLANS) for (const n of assembleModel(plan.kinds, undefined, true).model.nodes) gateKinds.add(n.kind);

  it("generate every kind the registry writes for Google Cloud", () => {
    const missing = KIND_DEFINITIONS.filter((k) => k.gcp && !gateKinds.has(k.kind)).map((k) => k.kind);
    assert.deepEqual(missing, []);
  });

  it("have distinct ids, each naming a document of its own", () => {
    assert.equal(new Set(GCP_PLANS.map((p) => p.id)).size, GCP_PLANS.length);
    for (const plan of GCP_PLANS) assert.match(plan.id, /^gcp-[a-z]+$/);
  });

  it("put the Pub/Sub topics, the BigQuery dataset and the buckets under the key store's key", () => {
    const data = GCP_PLANS.find((p) => p.id === "gcp-data");
    assert.ok(data);
    const text = main(data);
    assert.match(resourceText(text, "google_pubsub_topic", "queue"), /kms_key_name\s+= google_kms_crypto_key\.key_vault\.id/);
    assert.match(resourceText(text, "google_pubsub_topic", "queue_dead_letter"), /kms_key_name\s+= google_kms_crypto_key\.key_vault\.id/);
    assert.match(resourceText(text, "google_bigquery_dataset", "data_warehouse"), /default_encryption_configuration \{\n\s+kms_key_name\s+= google_kms_crypto_key\.key_vault\.id/);
    assert.match(resourceText(text, "google_storage_bucket", "object_storage"), /encryption \{\n\s+default_kms_key_name\s+= google_kms_crypto_key\.key_vault\.id/);
  });

  it("reach a GKE cluster, a virtual machine and the project they sit in", () => {
    const platform = GCP_PLANS.find((p) => p.id === "gcp-platform");
    assert.ok(platform);
    const text = main(platform);
    for (const type of ["google_container_cluster", "google_container_node_pool", "google_compute_instance", "google_project", "google_compute_network"]) {
      assert.match(text, new RegExp(`resource "${type}" `), type);
    }
  });

  it("reach the CDN in front of a static site, and App Engine behind a load balancer", () => {
    const site = main(GCP_PLANS.find((p) => p.id === "gcp-site") ?? assert.fail("site"));
    assert.match(site, /resource "google_compute_backend_bucket" /);
    assert.match(site, /resource "google_dns_managed_zone" /);
    assert.match(main(GCP_PLANS.find((p) => p.id === "gcp-data") ?? assert.fail("data")), /resource "google_app_engine_standard_app_version" /);
  });

  it("reach Cloud Run and Functions behind a load balancer, with a queue and no key store", () => {
    const text = main(GCP_PLANS.find((p) => p.id === "gcp-serverless") ?? assert.fail("serverless"));
    for (const type of ["google_cloud_run_v2_service", "google_cloudfunctions2_function", "google_pubsub_topic", "google_compute_backend_service"]) {
      assert.match(text, new RegExp(`resource "${type}" `), type);
    }
    assert.doesNotMatch(text, /kms_key_name/);
  });
});
