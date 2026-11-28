// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CATEGORY_GLYPHS,
  categoryOfType,
  drawioIconStyle,
  GRAPH_CATEGORIES,
  listServices,
  providerOfType,
  type ServiceInfo,
  serviceById,
  serviceLabel,
  serviceOf,
} from "terragram-engine/graph";

/**
 * The service table maps a Terraform resource type to a stable service id, a name and a category. The web app maps the id to an
 * icon and the Services level merges by it, so what these hold is that every type infraharvest can import has a row of its own.
 */

type Catalogue = { commit: string; aws: string[]; google: string[]; azurerm: string[]; azapi: string[] };
const catalogue = JSON.parse(readFileSync(new URL("./fixtures/graph/catalogue-types.json", import.meta.url), "utf8")) as Catalogue;

const ID = /^(aws|azure|gcp)\.[a-z0-9]+$|^terraform\.(module|group)$/;
const CLOUD_OF = { aws: "aws", google: "gcp", azurerm: "azure", azapi: "azure" } as const;

describe("the service table", () => {
  it("covers every type of infraharvest's catalogue with a row of its own, not a fallback", () => {
    assert.ok(catalogue.aws.length >= 236 && catalogue.google.length >= 88 && catalogue.azurerm.length >= 38, "the fixture lost types");
    const unmapped: string[] = [];
    for (const provider of ["aws", "google", "azurerm", "azapi"] as const) {
      for (const type of catalogue[provider]) {
        const service = serviceOf(type);
        if (!service.known) unmapped.push(type);
        assert.ok(service.id.startsWith(`${CLOUD_OF[provider]}.`), `${type} is ${service.id}`);
        assert.match(service.id, ID, type);
        assert.ok(GRAPH_CATEGORIES.includes(service.category), type);
        assert.equal(service.label, serviceById(service.id)?.label, type);
      }
    }
    assert.deepEqual(unmapped, [], "types with no row in the service table");
  });

  it("maps the types the brief names", () => {
    const rds: ServiceInfo = { id: "aws.rds", label: "RDS", category: "data", known: true };
    assert.deepEqual(serviceOf("aws_db_instance"), rds);
    assert.equal(serviceOf("aws_rds_cluster").id, "aws.rds");
    assert.equal(serviceOf("aws_redshift_cluster").id, "aws.redshift");
    assert.equal(serviceOf("azurerm_mssql_server").id, "azure.sql");
    assert.equal(serviceOf("azurerm_mssql_managed_instance").id, "azure.sqlmi");
    assert.equal(serviceOf("azurerm_kubernetes_cluster").id, "azure.aks");
    assert.equal(serviceOf("google_container_cluster").id, "gcp.gke");
    assert.equal(serviceOf("google_container_node_pool").id, "gcp.gke");
    assert.equal(serviceOf("aws_lambda_function").id, "aws.lambda");
    assert.equal(serviceOf("aws_lambda_layer_version").id, "aws.lambda");
  });

  it("lets a narrow rule win over the wide one it sits in", () => {
    assert.equal(serviceOf("aws_route53_zone").id, "aws.route53");
    assert.equal(serviceOf("aws_route53_resolver_rule").id, "aws.route53resolver");
    assert.equal(serviceOf("aws_ec2_transit_gateway_route_table").id, "aws.transitgateway");
    assert.equal(serviceOf("aws_ec2_something_new").id, "aws.ec2");
    assert.equal(serviceOf("aws_kinesis_firehose_delivery_stream").id, "aws.firehose");
    assert.equal(serviceOf("aws_kinesis_stream").id, "aws.kinesis");
    assert.equal(serviceOf("aws_cloudwatch_event_rule").id, "aws.eventbridge");
    assert.equal(serviceOf("aws_cloudwatch_log_group").id, "aws.cloudwatch");
    assert.equal(serviceOf("aws_vpc_security_group_ingress_rule").id, "aws.securitygroup");
    assert.equal(serviceOf("aws_vpc_endpoint").id, "aws.privatelink");
    assert.equal(serviceOf("aws_vpc_peering_connection").id, "aws.vpc");
    assert.equal(serviceOf("google_project_iam_member").id, "gcp.iam");
    assert.equal(serviceOf("google_project_service").id, "gcp.resourcemanager");
    assert.equal(serviceOf("google_compute_target_instance").id, "gcp.compute", "an exact type beats a prefix");
    assert.equal(serviceOf("google_compute_target_https_proxy").id, "gcp.loadbalancing");
    assert.equal(serviceOf("azurerm_resource_group").id, "azure.resourcegroup", "an exact type beats a prefix");
    assert.equal(serviceOf("azurerm_virtual_machine_scale_set").id, "azure.vmss");
    assert.equal(serviceOf("azuread_group").id, "azure.entra");
  });

  it("falls back to the provider and a category read off the type, and says so", () => {
    assert.deepEqual(serviceOf("aws_frobnicator_database"), { id: "aws.data", label: "AWS data resources", category: "data", known: false });
    assert.equal(serviceOf("google_frobnicator_network").id, "gcp.network");
    assert.equal(serviceOf("azurerm_frobnicator").id, "azure.other");
    assert.deepEqual(serviceOf("random_id"), { id: "other.other", label: "Other resources", category: "other", known: false });
    assert.equal(serviceOf("cloudflare_dns_record").label, "Other network resources");
    assert.equal(providerOfType("azapi_resource"), "azure");
    assert.equal(providerOfType("kubernetes_namespace"), "other");
    assert.equal(categoryOfType("aws_instance"), "compute");
    assert.equal(categoryOfType("aws_s3_bucket"), "storage");
    assert.equal(categoryOfType("aws_kms_key_thing"), "identity", "the first category whose words the type has");
  });

  it("names a service id, a fallback id too", () => {
    assert.equal(serviceLabel("aws.lambda"), "Lambda");
    assert.equal(serviceLabel("gcp.data"), "Google Cloud data resources");
    assert.equal(serviceLabel("azure.nonsense"), "Azure other resources");
    assert.equal(serviceLabel("whatever"), "Other resources");
    assert.equal(serviceById("aws.data"), undefined);
    assert.equal(serviceLabel("terraform.module"), "Module call");
  });

  it("lists services with unique ids, names that fit a card, and an own glyph for each category", () => {
    const services = listServices();
    assert.ok(services.length > 150);
    assert.equal(new Set(services.map((s) => s.id)).size, services.length);
    for (const s of services) {
      assert.match(s.id, ID);
      assert.ok(s.known && GRAPH_CATEGORIES.includes(s.category));
      assert.ok(s.label.length <= 20, `${s.id}: "${s.label}" is too long for a card`);
    }
    for (const category of GRAPH_CATEGORIES) assert.match(CATEGORY_GLYPHS[category], /^<(circle|rect|ellipse|path)/);
  });
});

describe("draw.io shape names", () => {
  it("names draw.io's own shape per service: the AWS 19 resource icon, the Azure 2 image, the Google Cloud 3 shape", () => {
    assert.match(drawioIconStyle("aws.lambda") ?? "", /shape=mxgraph\.aws4\.resourceIcon;resIcon=mxgraph\.aws4\.lambda;$/);
    assert.match(drawioIconStyle("aws.rds") ?? "", /fillColor=#C925D1.*resIcon=mxgraph\.aws4\.rds;$/);
    assert.equal(drawioIconStyle("azure.vm"), "image;aspect=fixed;image=img/lib/azure2/compute/Virtual_Machine.svg;");
    assert.match(drawioIconStyle("gcp.gke") ?? "", /fillColor=#4285f4;shape=mxgraph\.gcp3\.gke;$/);
    assert.match(drawioIconStyle("gcp.pubsub") ?? "", /shape=mxgraph\.gcp3\.integrationservices;$/, "a Google service without a product icon gets its category's");
  });

  it("has no shape for what draw.io has none for, and never writes markup or vendor art", () => {
    assert.equal(drawioIconStyle("aws.accessanalyzer"), undefined);
    assert.equal(drawioIconStyle("aws.data"), undefined);
    assert.equal(drawioIconStyle("terraform.module"), undefined);
    for (const s of listServices()) {
      const style = drawioIconStyle(s.id);
      if (style === undefined) continue;
      assert.match(style, /^[A-Za-z0-9_=#.;/-]+$/, s.id);
      assert.ok(!/html=|data:|<|>|base64/.test(style), s.id);
    }
  });
});
