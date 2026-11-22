// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attributesFromPrompt, composeFromPrompt, detectCloud } from "../src/features/workspace/engine.ts";
import { assessFeasibility } from "../src/features/workspace/feasibility.ts";
import { buildGraphModel } from "../src/features/workspace/graph-build.ts";
import { cloudSpec } from "../src/features/workspace/kinds.ts";
import { addNode, connectNodes } from "../src/features/workspace/inspector.ts";
import { EMPTY_MODEL } from "../src/features/workspace/model.ts";
import { MODULE_VERSIONS } from "../src/features/workspace/module-versions.ts";
import { parseTerraform } from "../src/features/workspace/parse.ts";
import { buildEvidenceReceipt } from "../src/features/workspace/sign.ts";
import { emitTerraform } from "../src/features/workspace/terraform.ts";

/**
 * The two flows the product is: a brief in plain English, and a picture of a
 * diagram, each ending in module-based Terraform that Terraform itself accepts.
 * `scripts/validate-emit.ts` is the gate that runs `terraform validate`; these
 * pin the facts that gate depends on, without the network.
 */

const LAMBDA_BRIEF =
  "create the infrastructure which allows me to deploy a lambda to AWS, powered by Python";

describe("a brief names its cloud and runtime", () => {
  it("reads AWS and Python from the Lambda brief", () => {
    assert.equal(detectCloud(LAMBDA_BRIEF), "aws");
    assert.deepEqual(attributesFromPrompt("functions", LAMBDA_BRIEF), { Runtime: "Python 3.12" });
  });

  it("reads Azure from an Azure brief, and nothing from a neutral one", () => {
    assert.equal(detectCloud("A web app on App Service with Cosmos DB"), "azure");
    assert.equal(detectCloud("A web app with a Postgres database"), null);
  });

  it("takes the destination when a brief names both clouds", () => {
    assert.equal(detectCloud("Move our Azure functions to AWS Lambda"), "aws");
  });

  it("carries the cloud on the result and sets the runtime on the node", () => {
    const result = composeFromPrompt(LAMBDA_BRIEF);
    assert.equal(result.cloud, "aws");
    const fn = result.model.nodes.find((n) => n.kind === "functions");
    assert.equal(fn?.attributes?.Runtime, "Python 3.12");
    assert.match(result.reply, /targeting AWS/);
    assert.match(result.reply, /Python 3\.12/);
    assert.ok(!result.added.includes("Internet"), "the conceptual node is not something we added");
  });

  it("leaves the runtime unset when the brief does not say", () => {
    const result = composeFromPrompt("Serverless functions with a queue");
    assert.equal(result.model.nodes.find((n) => n.kind === "functions")?.attributes, undefined);
  });
});

describe("the scaffold", () => {
  it("does not put a CDN in front of a Lambda nobody asked to front", () => {
    const { model } = composeFromPrompt(LAMBDA_BRIEF);
    assert.deepEqual(model.nodes.map((n) => n.kind).sort(), ["functions", "internet"]);
    assert.ok(model.edges.some((e) => e.source === "internet" && e.target === "functions"));
  });

  it("still fronts a web tier, and adds the CDN when the brief asks for one", () => {
    const web = composeFromPrompt("A web app with a Postgres database");
    assert.ok(web.model.nodes.some((n) => n.kind === "front-door"));
    const fronted = composeFromPrompt("A lambda behind a CDN");
    assert.ok(fronted.model.nodes.some((n) => n.kind === "front-door"));
  });
});

describe("module-based emission", () => {
  it("emits the Lambda brief as the lambda module with a Python runtime and a URL", () => {
    const { model } = composeFromPrompt(LAMBDA_BRIEF);
    const out = emitTerraform(model, "aws");
    const main = out.files[0]?.content ?? "";
    assert.match(main, /module "functions" \{/);
    assert.match(main, new RegExp(`source\\s+= "${MODULE_VERSIONS["aws/lambda"].source}"`));
    assert.match(main, new RegExp(`version\\s+= "${MODULE_VERSIONS["aws/lambda"].version}"`));
    assert.match(main, /runtime\s+= "python3\.12"/);
    assert.match(main, /handler\s+= "lambda_function\.lambda_handler"/);
    assert.match(main, /create_lambda_function_url\s+= true/);
    assert.match(main, /source_path\s+= "\$\{path\.module\}\/src\/functions"/);
    assert.doesNotMatch(main, /aws_cloudfront_distribution/);
    assert.doesNotMatch(main, /lambda_role_arn/, "the module owns the role now");
    assert.deepEqual(out.modules, [
      { name: "functions", source: MODULE_VERSIONS["aws/lambda"].source, version: MODULE_VERSIONS["aws/lambda"].version },
    ]);
  });

  it("wires an edge to a module through the module's output", () => {
    const { model } = composeFromPrompt("Serverless functions with a queue and a NoSQL store");
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    assert.match(main, /environment_variables\s+= \{[\s\S]*QUEUE_URL\s+= module\.queue\.queue_url/);
    assert.match(main, /DYNAMODB_TABLE\s+= module\.nosql\.dynamodb_table_id/);
  });

  it("completes a CloudFront distribution even when nothing sits behind it", () => {
    // A CDN placed on the canvas on its own — no serving tier for it to front.
    const added = addNode(EMPTY_MODEL, "front-door");
    assert.ok(added);
    const out = emitTerraform(added.model, "aws");
    const main = out.files[0]?.content ?? "";
    assert.match(main, /default_cache_behavior \{/);
    assert.match(main, /origin \{[\s\S]*domain_name\s+= var\.origin_domain_name/);
    assert.match(out.files[1]?.content ?? "", /variable "origin_domain_name"/);
  });

  it("creates the CloudFront web ACL and its log group in us-east-1, the only region they exist in", () => {
    const { model } = composeFromPrompt("A web app with a Postgres database");
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    assert.match(main, /provider "aws" \{\n\s+alias\s+= "us_east_1"\n\s+region = "us-east-1"/);
    for (const type of ["aws_wafv2_web_acl", "aws_cloudwatch_log_group", "aws_wafv2_web_acl_logging_configuration"]) {
      assert.match(main, new RegExp(`resource "${type}" "[a-z_]+" \\{\\n\\s+provider\\s+= aws\\.us_east_1`), type);
    }
    // WAF delivers only to a log group with this prefix.
    assert.match(main, /name\s+= "aws-waf-logs-\$\{var\.name_prefix\}-front-door"/);

    const lambda = emitTerraform(composeFromPrompt(LAMBDA_BRIEF).model, "aws").files[0]?.content ?? "";
    assert.doesNotMatch(lambda, /alias/, "no CloudFront, no second region");
  });

  it("serves a static site's index at the root, and leaves an application's root alone", () => {
    const site = emitTerraform(composeFromPrompt("A static site on a CDN").model, "aws").files[0]?.content ?? "";
    assert.match(site, /default_root_object = "index\.html"/);
    const app = emitTerraform(composeFromPrompt("A web app with a Postgres database").model, "aws").files[0]?.content ?? "";
    assert.doesNotMatch(app, /default_root_object/);
  });

  it("reads the edge's log group and lookups back as the edge, not as monitoring or untranslated blocks", () => {
    const { model } = composeFromPrompt("A containerised API behind a load balancer with a queue, MySQL and monitoring");
    const parsed = parseTerraform(emitTerraform(model, "aws").files[0]?.content ?? "");
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "front-door").length, 1);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "monitoring").length, 1);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "external").length, 0);
  });

  it("reads the secret's own key back as part of the secret store", () => {
    const added = addNode(EMPTY_MODEL, "key-vault");
    assert.ok(added);
    const parsed = parseTerraform(emitTerraform(added.model, "aws").files[0]?.content ?? "");
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.model.nodes.map((n) => n.kind).filter((k) => k !== "internet"), ["key-vault"]);
  });

  it("names a FIFO queue the way SQS requires", () => {
    const { model } = composeFromPrompt("Functions with a queue");
    const queue = model.nodes.find((n) => n.kind === "queue");
    assert.ok(queue);
    const fifo = {
      ...model,
      nodes: model.nodes.map((n) => (n.id === queue?.id ? { ...n, attributes: { Delivery: "Exactly once (FIFO)" } } : n)),
    };
    const main = emitTerraform(fifo, "aws").files[0]?.content ?? "";
    assert.match(main, /name\s+= "q-\$\{var\.name_prefix\}-queue\.fifo"/);
    assert.match(main, /fifo_queue\s+= true/);
  });
});

describe("Terraform → Diagram reads module calls back", () => {
  it("round-trips a module-based document to the same kinds, attributes and edges", () => {
    const { model } = composeFromPrompt("Python functions with a queue, Postgres 15 and a NoSQL store on AWS");
    const emitted = emitTerraform(model, "aws").files[0]?.content ?? "";
    const parsed = parseTerraform(emitted);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.cloud, "aws");
    const kinds = parsed.model.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["functions", "internet", "nosql", "postgres", "queue"]);
    assert.equal(parsed.model.nodes.find((n) => n.kind === "functions")?.attributes?.Runtime, "Python 3.12");
    assert.equal(parsed.model.nodes.find((n) => n.kind === "postgres")?.attributes?.["PostgreSQL version"], "PostgreSQL 15");
    const fn = parsed.model.nodes.find((n) => n.kind === "functions");
    const queue = parsed.model.nodes.find((n) => n.kind === "queue");
    assert.ok(parsed.model.edges.some((e) => e.source === fn?.id && e.target === queue?.id), "the functions → queue edge survives");
    assert.deepEqual(parsed.untranslated, []);
  });

  it("tells postgres from mysql on the shared RDS module by engine", () => {
    const source = `
module "db" {
  source  = "${MODULE_VERSIONS["aws/rds"].source}"
  version = "${MODULE_VERSIONS["aws/rds"].version}"
  engine  = "mysql"
  engine_version = "8.4"
}`;
    const parsed = parseTerraform(source);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.ok(parsed.model.nodes.some((n) => n.kind === "mysql"));
    assert.equal(parsed.model.nodes.find((n) => n.kind === "mysql")?.attributes?.["MySQL version"], "MySQL 8.4");
  });

  it("still flags a module it does not know rather than dropping it", () => {
    const parsed = parseTerraform(
      `module "x" {\n  source = "acme/thing/aws"\n}\n\nresource "aws_sqs_queue" "q" {\n  name = "q"\n}`,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.ok(parsed.model.nodes.some((n) => n.kind === "external" && n.label === "module x"));
    assert.deepEqual(parsed.untranslated, ["module.x"]);
  });
});

describe("feasibility", () => {
  it("says a whole diagram can be built when it can", () => {
    const { model } = composeFromPrompt("A web app with a Postgres database");
    const f = assessFeasibility(model, "aws");
    assert.equal(f.verdict, "full");
    assert.deepEqual(f.omitted, []);
    assert.match(f.summary, /All 3 components can be built on AWS/);
  });

  it("names what a picture showed that cannot be built, and suggests the nearest kind", () => {
    const { model } = buildGraphModel(
      [
        { ref: "a", label: "Users", kind: "internet" },
        { ref: "b", label: "Web App", kind: "app-service" },
        { ref: "c", label: "Kafka topic" },
        { ref: "d", label: "Mainframe" },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "b", to: "d" },
      ],
    );
    const f = assessFeasibility(model, "azure");
    assert.equal(f.verdict, "partial");
    assert.deepEqual(f.omitted, ["Kafka topic", "Mainframe"]);
    const kafka = f.components.find((c) => c.label === "Kafka topic");
    assert.equal(kafka?.status, "unsupported");
    assert.equal(kafka?.suggestion, "queue");
    assert.equal(f.components.find((c) => c.label === "Mainframe")?.suggestion, null);
    assert.match(f.summary, /1 of 3 components can be built on Azure/);
    assert.match(f.summary, /Kafka topic could be Message Queue/);
  });

  it("suggests the nearest kind for what the vocabulary does not name, and nothing for the rest", () => {
    // Labels the importer's own keyword match leaves unmatched, so the suggestion
    // comes from the nearest-kind table: one row per entry, plus the cases a bare
    // word used to misfile.
    const cases: Array<[label: string, suggestion: string | null]> = [
      ["Kafka topic", "queue"],
      ["Kinesis stream", "queue"],
      ["RabbitMQ", "queue"],
      ["OpenSearch", "nosql"],
      ["Elasticsearch cluster", "nosql"],
      ["File share", "object-storage"],
      ["EFS", "object-storage"],
      ["SFTP server", "object-storage"],
      ["NAT gateway", "vnet"],
      ["Reverse proxy", "front-door"],
      ["Virtual machine", "app-service"],
      ["EC2 instance", "app-service"],
      ["Mail server", "app-service"],
      ["Payment gateway", null],
      ["Instance profile", null],
      ["Mainframe", null],
    ];
    const { model } = buildGraphModel(
      cases.map(([label], i) => ({ ref: `n${i}`, label })),
      [],
    );
    const f = assessFeasibility(model, "aws");
    const got = cases.map(([label]) => {
      const c = f.components.find((x) => x.label === label);
      assert.equal(c?.status, "unsupported", `${label} is not in the vocabulary`);
      return [label, c?.suggestion ?? null];
    });
    assert.deepEqual(got, cases);
    // Every suggestion is a kind the reviewer can actually pick, on both clouds.
    for (const [, kind] of cases) {
      if (!kind) continue;
      assert.ok(cloudSpec(kind, "aws") && cloudSpec(kind, "azure"), `${kind} builds on both clouds`);
    }
  });

  it("counts flagged components as needing review, not as unbuildable", () => {
    const { model } = composeFromPrompt("A web app with a Redis cache");
    const f = assessFeasibility(model, "azure");
    assert.equal(f.verdict, "full");
    assert.equal(f.components.find((c) => c.kind === "redis-cache")?.status, "needs-review");
    assert.match(f.summary, /1 component needs review/);
  });
});

describe("the receipt", () => {
  it("records every module at its exact version, and what was left out", async () => {
    const { model } = buildGraphModel(
      [
        { ref: "a", label: "Functions", kind: "functions" },
        { ref: "b", label: "Kafka" },
      ],
      [{ from: "a", to: "b" }],
    );
    const { receipt } = await buildEvidenceReceipt(model, "aws", "deterministic", "reviewer", "2026-09-11T00:00:00.000Z");
    assert.ok(
      receipt.sbom.some((s) => s.name === MODULE_VERSIONS["aws/lambda"].source && s.version === MODULE_VERSIONS["aws/lambda"].version),
    );
    assert.deepEqual(receipt.omitted, ["Kafka"]);
  });
});

describe("a Lambda plan can be packaged", () => {
  const RUNTIMES = [
    ["Python 3.12", "lambda_function.py", "lambda_function.lambda_handler"],
    ["Node.js 22", "index.mjs", "index.handler"],
    ["Java 21", "example/Handler.java", "example.Handler::handleRequest"],
  ] as const;

  for (const [runtime, file, handler] of RUNTIMES) {
    it(`emits the ${runtime} handler file the module packages at plan time`, () => {
      const added = addNode(EMPTY_MODEL, "functions");
      assert.ok(added);
      const model = {
        ...added.model,
        nodes: added.model.nodes.map((n) =>
          n.kind === "functions" ? { ...n, attributes: { Runtime: runtime } } : n,
        ),
      };
      const out = emitTerraform(model, "aws");
      const main = out.files.find((f) => f.name === "main.tf")?.content ?? "";
      assert.match(main, /source_path\s+= "\$\{path\.module\}\/src\/functions"/);
      assert.match(main, new RegExp(String.raw`handler\s+= "${handler.replace(/[.$]/g, "\\$&")}"`));
      const stub = out.files.find((f) => f.name === `src/functions/${file}`);
      assert.ok(stub, `expected src/functions/${file} beside the plan`);
      assert.ok(stub.content.length > 0);
    });
  }

  it("hashes the handler file into the receipt, after the three plan files", async () => {
    const added = addNode(EMPTY_MODEL, "functions");
    assert.ok(added);
    const { receipt } = await buildEvidenceReceipt(added.model, "aws", "deterministic", "t", "2026-01-01T00:00:00Z");
    assert.deepEqual(receipt.plan, ["main.tf", "variables.tf", "outputs.tf", "src/functions/index.mjs"]);
  });
});

describe("a sensitive variable never has an empty default", () => {
  it("leaves db_password without a default so Terraform asks", () => {
    const added = addNode(EMPTY_MODEL, "postgres");
    assert.ok(added);
    const vars = emitTerraform(added.model, "azure").files.find((f) => f.name === "variables.tf")?.content ?? "";
    const block = vars.match(/variable "db_password" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(block, /sensitive\s+= true/);
    assert.doesNotMatch(block, /default/);
  });
});

describe("AWS network placement and load-balancer wiring", () => {
  const IN_VPC = "A containerised API behind a load balancer with a cache, in a private network";

  it("places the balancer, the tasks and the cache in the model's VPC", () => {
    const { model } = composeFromPrompt(IN_VPC);
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    assert.match(main, /module "vnet"/);
    assert.match(main, /module "load_balancer" \{[\s\S]*?subnets\s+= module\.vnet\.public_subnets/);
    assert.match(main, /module "containers" \{[\s\S]*?subnet_ids\s+= module\.vnet\.private_subnets/);
    assert.match(main, /module "redis_cache" \{[\s\S]*?subnet_ids\s+= module\.vnet\.private_subnets/);
    const vars = emitTerraform(model, "aws").files[1]?.content ?? "";
    assert.doesNotMatch(vars, /variable "(vpc_id|public_subnet_ids|private_subnet_ids)"/);
  });

  it("registers the ECS service with the balancer's target group, and admits only the balancer", () => {
    const { model } = composeFromPrompt(IN_VPC);
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    const service = main.match(/module "containers" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(service, /target_group_arn\s+= module\.load_balancer\.target_groups\["app"\]\.arn/);
    assert.match(service, /container_name\s+= "app"/);
    assert.match(service, /referenced_security_group_id = module\.load_balancer\.security_group_id/);
    assert.doesNotMatch(main, /aws_lb_target_group_attachment/);
    assert.match(main, /target_type\s+= "ip"/);
    assert.match(main, /listeners = \{/);
  });

  it("attaches an instance to the balancer by private IP", () => {
    const { model } = composeFromPrompt("A web app behind a load balancer, in a private network");
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    assert.match(main, /module "app_service" \{[\s\S]*?source\s+= "terraform-aws-modules\/ec2-instance\/aws"/);
    assert.match(main, /resource "aws_lb_target_group_attachment" "load_balancer_to_app_service"/);
    assert.match(main, /target_id\s+= module\.app_service\.private_ip/);
    assert.match(main, /http_tokens\s+= "required"/);
    assert.doesNotMatch(main, /var\.web_ami/);
  });

  it("asks for the network when the model has none, with no empty defaults", () => {
    const { model } = composeFromPrompt("A containerised API behind a load balancer");
    const out = emitTerraform(model, "aws");
    const vars = out.files[1]?.content ?? "";
    for (const name of ["vpc_id", "public_subnet_ids", "private_subnet_ids"]) {
      const block = vars.match(new RegExp(String.raw`variable "${name}" \{[\s\S]*?\n\}`))?.[0] ?? "";
      assert.ok(block, `expected variable ${name}`);
      assert.doesNotMatch(block, /default/);
    }
  });

  it("reads its own module-based ECS output back to one containers node", () => {
    const { model } = composeFromPrompt(IN_VPC);
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    const parsed = parseTerraform(main);
    assert.ok(parsed.ok);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "containers").length, 1);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "external").length, 0, "the cluster module is not an untranslated block");
  });

  it("gives the balancer egress to the targets it registers, and nowhere else", () => {
    const main = emitTerraform(composeFromPrompt(IN_VPC).model, "aws").files[0]?.content ?? "";
    const balancer = main.match(/module "load_balancer" \{[\s\S]*?\n\}/)?.[0] ?? "";
    const egress = balancer.match(/security_group_egress_rules = \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    assert.match(egress, /containers = \{[\s\S]*?referenced_security_group_id = module\.containers\.security_group_id/);
    assert.doesNotMatch(egress, /cidr_ipv4/);
  });
});

describe("a DNS zone's name is served, not left dangling", () => {
  const SITE = "A static site on a CDN with its own DNS zone and object storage";

  /** dns → <ingress> → containers, drawn by hand: the derived spine always puts a
   *  CDN between a zone and a load balancer. */
  function zoneInFront(ingress: string) {
    let model = EMPTY_MODEL;
    const ids: string[] = [];
    for (const kind of ["dns", ingress, "containers"]) {
      const added = addNode(model, kind);
      assert.ok(added);
      model = added.model;
      ids.push(added.id);
    }
    model = connectNodes(model, ids[0] ?? "", ids[1] ?? "");
    return connectNodes(model, ids[1] ?? "", ids[2] ?? "");
  }

  it("puts the zone's www name on the CloudFront distribution, on a us-east-1 certificate validated in the zone", () => {
    const main = emitTerraform(composeFromPrompt(SITE).model, "aws").files[0]?.content ?? "";
    const distribution = main.match(/resource "aws_cloudfront_distribution" "front_door" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(distribution, /aliases\s+= \["www\.example\.gov\.uk"\]/);
    assert.match(distribution, /acm_certificate_arn\s+= aws_acm_certificate_validation\.dns_to_front_door\.certificate_arn/);
    assert.match(distribution, /ssl_support_method\s+= "sni-only"/);
    assert.match(distribution, /minimum_protocol_version = "TLSv1\.2_2021"/);
    assert.doesNotMatch(distribution, /cloudfront_default_certificate/);
    assert.match(
      main,
      /resource "aws_acm_certificate" "dns_to_front_door" \{\n\s+provider\s+= aws\.us_east_1\n\s+domain_name\s+= "www\.example\.gov\.uk"\n\s+validation_method = "DNS"/,
    );
    assert.match(main, /resource "aws_acm_certificate_validation" "dns_to_front_door" \{\n\s+provider\s+= aws\.us_east_1/);
    // The validation records go in the plan's own zone; the www record stays a CNAME.
    assert.match(main, /resource "aws_route53_record" "dns_to_front_door_validation" \{[\s\S]*?zone_id\s+= module\.dns\.id/);
    assert.match(main, /resource "aws_route53_record" "dns_to_front_door" \{[\s\S]*?type\s+= "CNAME"/);
  });

  it("tells the reviewer that apply waits on validation until the zone is delegated", () => {
    const main = emitTerraform(composeFromPrompt(SITE).model, "aws").files[0]?.content ?? "";
    const header = main.slice(0, main.indexOf("terraform {"));
    assert.match(header, /# Before you apply: www\.example\.gov\.uk is served over HTTPS/);
    assert.match(header, /terraform apply -target=module\.dns/);
    assert.match(header, /dns_name_servers output/);
    assert.match(header, /apply waits on the certificate's validation/);
  });

  it("keeps CloudFront's default certificate, and says nothing, when no zone points at the distribution", () => {
    const main = emitTerraform(composeFromPrompt("A static site on a CDN").model, "aws").files[0]?.content ?? "";
    assert.match(main, /cloudfront_default_certificate = true/);
    assert.doesNotMatch(main, /aliases|aws_acm_certificate|Before you apply/);
  });

  it("gives Front Door the zone's name with a managed certificate, its validation token, the route and the WAF", () => {
    const main = emitTerraform(composeFromPrompt(SITE).model, "azure").files[0]?.content ?? "";
    assert.match(main, /front_door_custom_domains = \{\n\s+dns_to_front_door = \{/);
    assert.match(main, /host_name\s+= "www\.example\.gov\.uk"/);
    assert.match(main, /dns_zone_id = module\.dns\.resource_id/);
    assert.match(main, /certificate_type = "ManagedCertificate"/);
    assert.match(main, /custom_domain_keys\s+= \["dns_to_front_door"\]/);
    assert.match(main, /domain_keys\s+= \["dns_to_front_door"\]/);
    assert.match(main, /name\s+= "_dnsauth\.www"/);
    assert.match(main, /value = module\.front_door\.frontdoor_custom_domains\["dns_to_front_door"\]\.validation_token/);
    assert.match(main, /# Before you apply: www\.example\.gov\.uk/);
  });

  it("terminates TLS on a load balancer the zone points at, and only redirects plain HTTP", () => {
    const main = emitTerraform(zoneInFront("load-balancer"), "aws").files[0]?.content ?? "";
    const balancer = main.match(/module "load_balancer" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(balancer, /https = \{[\s\S]*?protocol\s+= "HTTPS"[\s\S]*?certificate_arn = aws_acm_certificate_validation\.dns_to_load_balancer\.certificate_arn/);
    assert.match(balancer, /http = \{[\s\S]*?redirect = \{[\s\S]*?protocol\s+= "HTTPS"[\s\S]*?status_code = "HTTP_301"/);
    // A regional certificate: the balancer is in the plan's own region.
    assert.match(main, /resource "aws_acm_certificate" "dns_to_load_balancer" \{\n\s+domain_name/);
  });

  it("leaves a load balancer with no name of its own on plain HTTP", () => {
    const main =
      emitTerraform(composeFromPrompt("A containerised API behind a load balancer").model, "aws").files[0]?.content ?? "";
    const balancer = main.match(/module "load_balancer" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(balancer, /protocol\s+= "HTTP"/);
    assert.doesNotMatch(balancer, /HTTPS"|redirect|certificate_arn/);
  });

  it("reads the certificate back as part of the edge", () => {
    const parsed = parseTerraform(emitTerraform(composeFromPrompt(SITE).model, "aws").files[0]?.content ?? "");
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "front-door").length, 1);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "external").length, 0);
    assert.ok(!parsed.untranslated.some((u) => u.startsWith("aws_acm_certificate")));
  });

  it("publishes an address-only tier under an alias A record, not a CNAME", () => {
    let model = EMPTY_MODEL;
    const zone = addNode(model, "dns");
    assert.ok(zone);
    const lb = addNode(zone.model, "load-balancer");
    assert.ok(lb);
    model = connectNodes(lb.model, zone.id, lb.id);
    const main = emitTerraform(model, "azure").files[0]?.content ?? "";
    assert.match(main, /a_records = \{[\s\S]*?target_resource_id\s+= module\.load_balancer\.azurerm_public_ip\["public"\]\.id/);
    assert.doesNotMatch(main, /cname_records/);
  });
});

describe("storage the plan wires is hardened where it is wired", () => {
  it("logs each bucket's access to a bucket of its own, which reads back as part of the bucket", () => {
    const main = emitTerraform(composeFromPrompt("A static site on a CDN with object storage").model, "aws").files[0]?.content ?? "";
    assert.match(
      main,
      /module "object_storage_logs" \{[\s\S]*?access_log_delivery_policy_source_buckets = \[module\.object_storage\.s3_bucket_arn\]/,
    );
    assert.match(main, /module "static_site_logs" \{/);
    const parsed = parseTerraform(main);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepEqual(
      parsed.model.nodes.map((n) => n.kind).sort(),
      ["front-door", "internet", "object-storage", "static-site"],
    );
    assert.deepEqual(parsed.untranslated, []);
  });

  it("encrypts a bucket wired to the secret store under the store's own key", () => {
    let model = EMPTY_MODEL;
    const bucket = addNode(model, "object-storage");
    assert.ok(bucket);
    const store = addNode(bucket.model, "key-vault");
    assert.ok(store);
    model = connectNodes(store.model, bucket.id, store.id);
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    assert.match(main, /sse_algorithm\s+= "aws:kms"\n\s+kms_master_key_id = aws_kms_key\.key_vault\.arn/);
    const alone = emitTerraform(bucket.model, "aws").files[0]?.content ?? "";
    assert.doesNotMatch(alone, /kms_master_key_id/);
  });
});

describe("CloudFront reaches each origin the way the origin serves", () => {
  const originOf = (main: string, id: string) =>
    main.match(new RegExp(String.raw`origin \{\n\s+domain_name\s+= [^\n]+\n\s+origin_id\s+= "${id}"[\s\S]*?\n {2}\}`))?.[0] ?? "";

  it("asks a load balancer and an instance for plain HTTP, and a function URL for HTTPS", () => {
    const alb = emitTerraform(composeFromPrompt("A containerised API behind a load balancer").model, "aws").files[0]?.content ?? "";
    assert.match(originOf(alb, "front_door_to_load_balancer"), /origin_protocol_policy = "http-only"/);
    const ec2 = emitTerraform(composeFromPrompt("A web app with a Postgres database").model, "aws").files[0]?.content ?? "";
    assert.match(originOf(ec2, "front_door_to_app_service"), /origin_protocol_policy = "http-only"/);
    const fn = emitTerraform(composeFromPrompt("A serverless API on a CDN").model, "aws").files[0]?.content ?? "";
    assert.match(originOf(fn, "front_door_to_functions"), /origin_protocol_policy = "https-only"/);
  });

  it("asks a load balancer for HTTPS on its certificate's name once the zone has given it one", () => {
    let model = EMPTY_MODEL;
    const ids: string[] = [];
    for (const kind of ["dns", "front-door", "load-balancer", "containers"]) {
      const added = addNode(model, kind);
      assert.ok(added);
      model = added.model;
      ids.push(added.id);
    }
    const [dns = "", cdn = "", lb = "", app = ""] = ids;
    // The CDN's edge first: the zone's edge still decides the balancer's name.
    model = connectNodes(connectNodes(connectNodes(model, cdn, lb), dns, lb), lb, app);
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    const origin = originOf(main, "front_door_to_load_balancer");
    assert.match(origin, /domain_name\s+= "www\.example\.gov\.uk"/);
    assert.match(origin, /origin_protocol_policy = "https-only"/);
  });

  it("reads a site bucket through an origin access control the bucket's policy admits, and nothing else", () => {
    const main = emitTerraform(composeFromPrompt("A static site on a CDN").model, "aws").files[0]?.content ?? "";
    assert.match(
      main,
      /resource "aws_cloudfront_origin_access_control" "front_door_to_static_site" \{[\s\S]*?origin_access_control_origin_type = "s3"[\s\S]*?signing_protocol\s+= "sigv4"/,
    );
    const origin = originOf(main, "front_door_to_static_site");
    assert.match(origin, /origin_access_control_id = aws_cloudfront_origin_access_control\.front_door_to_static_site\.id/);
    assert.doesNotMatch(origin, /custom_origin_config/);
    const site = main.match(/module "static_site" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(site, /attach_policy\s+= true/);
    assert.match(site, /Principal = \{ Service = "cloudfront\.amazonaws\.com" \}/);
    assert.match(site, /Resource {2}= "arn:aws:s3:::site-\$\{var\.name_prefix\}-static-site\/\*"/);
    assert.match(site, /"AWS:SourceArn" = aws_cloudfront_distribution\.front_door\.arn/);
    const parsed = parseTerraform(main);
    assert.ok(parsed.ok);
    if (parsed.ok) assert.ok(!parsed.untranslated.some((u) => u.includes("origin_access_control")));
  });
});

describe("an Azure plan keeps its secrets and data on a private network", () => {
  it("adds the network a plan needs when the model draws none, with a subnet per integrated app", () => {
    const main = emitTerraform(composeFromPrompt("A web app with a Postgres database and a secret store").model, "azure").files[0]?.content ?? "";
    const network = main.match(/module "network" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(network, /source\s+= "Azure\/avm-res-network-virtualnetwork\/azurerm"/);
    assert.match(network, /app-service = \{[\s\S]*?delegations\s+= \[\{ name = "delegation", service_delegation = \{ name = "Microsoft\.Web\/serverFarms" \} \}\]/);
    assert.match(network, /private-endpoints = \{/);
    assert.match(main, /virtual_network_subnet_id\s+= module\.network\.subnets\["app-service"\]\.resource_id/);
    for (const zone of ["privatelink.postgres.database.azure.com", "privatelink.vaultcore.azure.net"]) {
      assert.match(main, new RegExp(String.raw`domain_name = "${zone.replace(/\./g, "\\.")}"[\s\S]*?virtual_network_id = module\.network\.resource_id`));
    }
    assert.match(main, /# Private network: Key Vault and PostgreSQL accept connections only through private endpoints/);
  });

  it("uses the model's own network when it draws one", () => {
    const main = emitTerraform(
      composeFromPrompt("A containerised API behind a load balancer with a cache and a Postgres database, in a private network").model,
      "azure",
    ).files[0]?.content ?? "";
    assert.doesNotMatch(main, /module "network"/);
    const vnet = main.match(/module "vnet" \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(vnet, /containers = \{[\s\S]*?Microsoft\.App\/environments[\s\S]*?\}/);
    assert.match(vnet, /default_outbound_access_enabled = true/);
    assert.match(main, /infrastructure_subnet_id = module\.vnet\.subnets\["containers"\]\.resource_id/);
    assert.match(main, /subnet_resource_id\s+= module\.vnet\.subnets\["private-endpoints"\]\.resource_id/);
  });

  it("runs functions on Flex Consumption, the consumption plan that can join a network", () => {
    const main = emitTerraform(composeFromPrompt("Python functions with a queue").model, "azure").files[0]?.content ?? "";
    assert.match(main, /sku_name\s+= "FC1"/);
    assert.match(main, /function_app_uses_fc1\s+= true/);
    assert.match(main, /fc1_runtime_name\s+= "python"/);
    assert.match(main, /storage_container_endpoint\s+= "https:\/\/\$\{module\.functions_storage\.fqdn\["blob"\]\}\/deployments"/);
    assert.match(main, /virtual_network_subnet_id\s+= module\.network\.subnets\["functions"\]\.resource_id/);
    assert.match(main, /Microsoft\.App\/environments/);
  });

  it("reads its own private network back as scaffolding, not as components", () => {
    const { model } = composeFromPrompt("A web app with a Postgres database and a secret store");
    const parsed = parseTerraform(emitTerraform(model, "azure").files[0]?.content ?? "");
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepEqual(
      parsed.model.nodes.map((n) => n.kind).sort(),
      model.nodes.map((n) => n.kind).sort(),
    );
    assert.deepEqual(parsed.untranslated, []);
  });

});
