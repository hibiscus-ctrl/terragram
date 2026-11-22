import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeFromPrompt } from "../src/features/workspace/engine.ts";
import { addNode, setNodeAttribute } from "../src/features/workspace/inspector.ts";
import { fieldsForKind } from "../src/features/workspace/kinds.ts";
import { type Cloud, EMPTY_MODEL } from "../src/features/workspace/model.ts";
import { emitTerraform } from "../src/features/workspace/terraform.ts";

/**
 * The hardening each kind carries by default — pinned so that an edit to a spec
 * cannot silently drop a TLS floor or a backup. Each entry is one fact a reviewer
 * would check first; the attribute names are the provider's own, and the emit
 * gate's `terraform validate` is what proves they still exist.
 *
 * Module-backed AWS kinds are listed where the module's default is off (or
 * unknown), and where the plan states a default anyway — RDS encryption at rest,
 * S3 public-access blocks — so a bump that changed the default cannot change the
 * plan. SQS SSE is the module's default and is not restated.
 */
const EXPECTED: Array<{ kind: string; cloud: Cloud; facts: RegExp[] }> = [
  {
    kind: "object-storage",
    cloud: "azure",
    facts: [
      /min_tls_version\s+= "TLS1_2"/,
      /https_traffic_only_enabled\s+= true/,
      /allow_nested_items_to_be_public\s+= false/,
      /shared_access_key_enabled\s+= false/,
      /versioning_enabled = true/,
    ],
  },
  {
    kind: "functions",
    cloud: "azure",
    // No storage key anywhere in the plan: the app reaches its own account as
    // itself, which is what the role assignment beside it is for.
    facts: [
      /https_only\s+= true/,
      /ftps_state\s+= "Disabled"/,
      /minimum_tls_version\s+= "1\.3"/,
      /system_assigned = true/,
      /shared_access_key_enabled\s+= false/,
      /storage_uses_managed_identity\s+= true/,
      /role_definition_name = "Storage Blob Data Owner"/,
    ],
  },
  {
    kind: "app-service",
    cloud: "azure",
    facts: [
      /https_only\s+= true/,
      /ftps_state\s+= "Disabled"/,
      /http2_enabled\s+= true/,
      /system_assigned = true/,
    ],
  },
  {
    kind: "key-vault",
    cloud: "azure",
    facts: [
      /purge_protection_enabled\s+= true/,
      /soft_delete_retention_days\s+= 90/,
      /default_action = "Deny"/,
      /bypass\s+= "AzureServices"/,
      /public_network_access_enabled = false/,
      /private_dns_zone_resource_ids = \[module\.private_dns_vaultcore\.resource_id\]/,
    ],
  },
  // Closed to the internet, reached through a private endpoint in the plan's
  // network. The module's own default firewall rule is the whole internet, so
  // the rule set is stated empty.
  {
    kind: "postgres",
    cloud: "azure",
    facts: [
      /backup_retention_days\s+= 7/,
      /public_network_access_enabled = false/,
      /firewall_rules\s+= \{\}/,
      /private_dns_zone_resource_ids = \[module\.private_dns_postgres\.resource_id\]/,
      /name\s+= "log_connections"/,
      /name\s+= "log_checkpoints"/,
      /name\s+= "connection_throttle\.enable"/,
    ],
  },
  {
    kind: "mysql",
    cloud: "azure",
    facts: [/backup_retention_days\s+= 7/, /public_network_access\s+= "Disabled"/, /subresource_name\s+= "mysqlServer"/],
  },
  { kind: "redis-cache", cloud: "azure", facts: [/minimum_tls_version\s+= "1\.2"/, /enable_non_ssl_port\s+= false/] },
  { kind: "queue", cloud: "azure", facts: [/minimum_tls_version\s+= "1\.2"/] },
  { kind: "nosql", cloud: "azure", facts: [/minimal_tls_version\s+= "Tls12"/, /local_authentication_disabled\s+= true/] },
  { kind: "front-door", cloud: "azure", facts: [/Microsoft_DefaultRuleSet/, /mode\s+= "Prevention"/, /front_door_security_policies = \{/] },

  {
    kind: "front-door",
    cloud: "aws",
    facts: [
      /AWSManagedRulesCommonRuleSet/,
      /AWSManagedRulesKnownBadInputsRuleSet/,
      /web_acl_id\s+= aws_wafv2_web_acl/,
      /resource "aws_wafv2_web_acl_logging_configuration"/,
      /retention_in_days = 365/,
      /response_headers_policy_id = data\.aws_cloudfront_response_headers_policy\.\w+\.id/,
      /name = "Managed-SecurityHeadersPolicy"/,
    ],
  },
  { kind: "key-vault", cloud: "aws", facts: [/kms_key_id = aws_kms_key\.\w+\.arn/, /enable_key_rotation = true/, /policy = jsonencode/] },
  { kind: "app-service", cloud: "aws", facts: [/http_tokens\s+= "required"/, /encrypted\s+= true/, /monitoring\s+= true/, /AmazonSSMManagedInstanceCore/] },
  {
    kind: "postgres",
    cloud: "aws",
    facts: [
      /backup_retention_period\s+= 7/,
      /manage_master_user_password\s+= true/,
      /storage_encrypted\s+= true/,
      /iam_database_authentication_enabled\s+= true/,
      /deletion_protection\s+= true/,
      /performance_insights_enabled\s+= true/,
    ],
  },
  {
    kind: "mysql",
    cloud: "aws",
    facts: [/backup_retention_period\s+= 7/, /iam_database_authentication_enabled\s+= true/, /deletion_protection\s+= true/],
  },
  { kind: "nosql", cloud: "aws", facts: [/point_in_time_recovery_enabled\s+= true/, /server_side_encryption_enabled\s+= true/] },
  { kind: "redis-cache", cloud: "aws", facts: [/at_rest_encryption_enabled\s+= true/, /transit_encryption_enabled\s+= true/] },
  { kind: "vnet", cloud: "aws", facts: [/enable_flow_log\s+= true/] },
  { kind: "functions", cloud: "aws", facts: [/tracing_mode\s+= "Active"/, /cloudwatch_logs_retention_in_days\s+= 30/] },
  {
    kind: "object-storage",
    cloud: "aws",
    facts: [
      /versioning = \{/,
      /object_ownership\s+= "BucketOwnerEnforced"/,
      /block_public_policy\s+= true/,
      /restrict_public_buckets\s+= true/,
      /sse_algorithm = "aws:kms"/,
      /target_bucket = module\.\w+_logs\.s3_bucket_id/,
      /attach_access_log_delivery_policy\s+= true/,
    ],
  },
  {
    kind: "static-site",
    cloud: "aws",
    facts: [/versioning = \{/, /block_public_acls\s+= true/, /sse_algorithm = "AES256"/, /target_bucket = module\.\w+_logs/],
  },
  {
    kind: "load-balancer",
    cloud: "aws",
    facts: [
      /target_type\s+= "ip"/,
      /security_group_ingress_rules = \{/,
      /listeners = \{/,
      /drop_invalid_header_fields\s+= true/,
    ],
  },
];

describe("hardening every kind carries by default", () => {
  for (const { kind, cloud, facts } of EXPECTED) {
    it(`${kind} on ${cloud}`, () => {
      const added = addNode(EMPTY_MODEL, kind);
      assert.ok(added, `kind ${kind} exists`);
      const main = emitTerraform(added.model, cloud).files[0]?.content ?? "";
      for (const fact of facts) assert.match(main, fact);
    });
  }
});

/**
 * Tagging and production posture — the two things a generated plan is asked for
 * the moment it stops being a demo.
 *
 * Tags are checked as one fact per cloud because there is exactly one mechanism
 * on each: a provider-level `default_tags` on AWS, a `tags` input on every module
 * on Azure. Posture is checked as a difference rather than a value, because what
 * matters is that the reviewer's choice moves the plan at all — a "Production"
 * option that emitted the same HCL as "Dev / Test" would pass any assertion about
 * either one on its own.
 */
describe("every resource carries the plan's tags", () => {
  it("applies them once, at the AWS provider", () => {
    const added = addNode(EMPTY_MODEL, "object-storage");
    assert.ok(added);
    const main = emitTerraform(added.model, "aws").files[0]?.content ?? "";
    assert.match(main, /default_tags \{\n\s+tags = local\.tags/);
    assert.match(main, /locals \{\n\s+tags = merge\(\{ ManagedBy = "terragram"/);
  });

  it("applies them to every Azure module call, because Azure has no provider default", () => {
    const added = addNode(EMPTY_MODEL, "object-storage");
    assert.ok(added);
    const main = emitTerraform(added!.model, "azure").files[0]?.content ?? "";
    const calls = main.match(/^module "/gm)?.length ?? 0;
    const tagged = main.match(/^\s+tags\s+= local\.tags$/gm)?.length ?? 0;
    assert.ok(calls >= 2, "the resource group and the storage account are both modules");
    assert.equal(tagged, calls, "every module call carries the tags");
  });

  it("lets the reviewer's own tags win, and asks for nothing it can't know", () => {
    const added = addNode(EMPTY_MODEL, "object-storage");
    assert.ok(added);
    const out = emitTerraform(added!.model, "azure");
    const vars = out.files.find((f) => f.name === "variables.tf")?.content ?? "";
    // merge(base, var.tags) — the second argument wins, so Owner and CostCentre
    // set by a reviewer are not overwritten by anything the plan assumed.
    assert.match(out.files[0]?.content ?? "", /merge\(\{[^}]*\}, var\.tags\)/);
    assert.match(vars, /variable "tags"/);
    assert.match(vars, /default\s+= \{\}/);
  });

  it("names the environment from the model rather than a default", () => {
    const dev = addNode(EMPTY_MODEL, "postgres");
    assert.ok(dev);
    assert.match(emitTerraform(dev!.model, "aws").files[0]?.content ?? "", /Environment = "dev"/);

    const production = setNodeAttribute(dev!.model, dev!.id, "Environment", "Production");
    assert.match(
      emitTerraform(production, "aws").files[0]?.content ?? "",
      /Environment = "production"/,
    );
  });
});

describe("production posture follows the reviewer's choice", () => {
  const cases: Array<{ kind: string; cloud: Cloud; dev: RegExp[]; production: RegExp[] }> = [
    {
      kind: "postgres",
      cloud: "aws",
      // A week of backups and no final snapshot while it is a trial; long
      // retention, a standby and a final snapshot when it is not. Deletion
      // protection, encryption and the managed master password are on either way.
      dev: [/backup_retention_period\s+= 7/, /skip_final_snapshot\s+= true/],
      production: [/backup_retention_period\s+= 35/, /skip_final_snapshot\s+= false/, /multi_az\s+= true/],
    },
    {
      kind: "mysql",
      cloud: "aws",
      dev: [/backup_retention_period\s+= 7/, /multi_az\s+= false/],
      production: [/backup_retention_period\s+= 35/, /multi_az\s+= true/],
    },
    {
      kind: "postgres",
      cloud: "azure",
      dev: [/backup_retention_days\s+= 7/, /high_availability\s+= null/, /geo_redundant_backup_enabled\s+= false/],
      production: [
        /backup_retention_days\s+= 35/,
        /mode = "ZoneRedundant"/,
        /geo_redundant_backup_enabled\s+= true/,
      ],
    },
    {
      kind: "mysql",
      cloud: "azure",
      dev: [/high_availability\s+= null/],
      production: [/mode = "ZoneRedundant"/],
    },
    {
      kind: "nosql",
      cloud: "aws",
      dev: [/deletion_protection_enabled\s+= false/],
      production: [/deletion_protection_enabled\s+= true/],
    },
    {
      kind: "nosql",
      cloud: "azure",
      dev: [/type = "Periodic"/],
      production: [/type = "Continuous"/, /automatic_failover_enabled\s+= true/],
    },
  ];

  for (const { kind, cloud, dev, production } of cases) {
    it(`${kind} on ${cloud}`, () => {
      const added = addNode(EMPTY_MODEL, kind);
      assert.ok(added);
      const devMain = emitTerraform(added!.model, cloud).files[0]?.content ?? "";
      for (const fact of dev) assert.match(devMain, fact, `dev: ${fact}`);

      const chosen = setNodeAttribute(added!.model, added!.id, "Environment", "Production");
      const prodMain = emitTerraform(chosen, cloud).files[0]?.content ?? "";
      for (const fact of production) assert.match(prodMain, fact, `production: ${fact}`);

      assert.notEqual(devMain, prodMain, "the choice has to change the plan");
    });
  }

  it("is a choice the brief can make and the reviewer can see", () => {
    assert.ok(
      fieldsForKind("postgres").some((f) => f.key === "Environment"),
      "the inspector offers it",
    );
    const { model } = composeFromPrompt("A production Postgres database");
    const db = model.nodes.find((n) => n.kind === "postgres");
    assert.equal(db?.attributes?.Environment, "Production");
    const sandbox = composeFromPrompt("A Postgres database for a sandbox").model;
    assert.equal(
      sandbox.nodes.find((n) => n.kind === "postgres")?.attributes?.Environment,
      "Dev / Test",
    );
  });
});
