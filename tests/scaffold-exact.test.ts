// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeFromPrompt } from "terragram-engine/engine";
import { type HclBlock, parseHcl } from "terragram-engine/hcl";
import { isScaffoldModule } from "terragram-engine/kinds";
import { parseTerraform } from "terragram-engine/parse";
import { emitTerraform } from "terragram-engine/terraform";

/**
 * What a plan adds around its Azure and AWS components (the resource group, the network and private
 * DNS zones, the access-log bucket) is hidden when reading it back, but only when it is exactly what
 * the generator writes and a component of the file uses it. A real resource that merely has the same
 * source, name or input is a component and is drawn.
 */

const mainOf = (prompt: string, cloud: "azure" | "aws"): string => emitTerraform(composeFromPrompt(prompt).model, cloud).files[0]?.content ?? "";

const AZURE = mainOf("A web app with a Postgres database and a secret store", "azure");
const AWS = mainOf("A static website with a bucket", "aws");

/** The modules of `source` that are hidden, by label. */
function hidden(source: string): string[] {
  const blocks = parseHcl(source);
  return blocks.filter((b) => b.type === "module" && isScaffoldModule(b, blocks)).map((b) => b.labels[0] ?? "");
}

/** Replace the one line of `source` that is `from` (trimmed) with `to`, failing when there is none. */
function edit(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `no "${from}" to edit`);
  return source.replace(from, to);
}

/** The text of one module block. */
function moduleText(source: string, name: string): string {
  const start = source.indexOf(`module "${name}" {`);
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n}\n", start) + 3);
}

/** A module a file draws of its own: an unrelated Azure Verified Module reading the plan's group. */
const USES = (...labels: string[]) => `module "mine" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "0.6.8"
  inputs  = [${labels.map((l) => `module.${l}.resource_id`).join(", ")}]
}
`;

/** A module's text without its \`subnets\` input. */
function withoutSubnets(text: string): string {
  const start = text.indexOf("\n  subnets = {");
  assert.notEqual(start, -1);
  return text.slice(0, start) + text.slice(text.indexOf("\n  }\n", start) + "\n  }".length);
}

describe("the Azure plan's own modules are hidden when read back", () => {
  it("hides the resource group, the network and the private DNS zones a plan writes, and nothing a component is", () => {
    assert.deepEqual(hidden(AZURE).sort(), ["network", "private_dns_postgres", "private_dns_vaultcore", "resource_group"]);
    const parsed = parseTerraform(AZURE);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.untranslated, []);
  });
});

describe("only the resource group the generator writes is hidden", () => {
  const group = moduleText(AZURE, "resource_group");
  const GROUP = (body: string) => `${body}\n${USES(/module "([^"]+)"/.exec(body)?.[1] ?? "")}`;

  it("draws a group that nothing uses", () => {
    assert.deepEqual(hidden(group), []);
  });

  it("hides the group a component uses, whatever version of the module it names", () => {
    assert.deepEqual(hidden(GROUP(group)), ["resource_group"]);
    assert.deepEqual(hidden(GROUP(group.replace(/version\s+= "[^"]+"/, 'version = "0.1.0"'))), ["resource_group"]);
  });

  const nearMisses: Array<[string, (g: string) => string]> = [
    ["another name", (g) => g.replace('"resource_group"', '"shared_rg"')],
    ["a name of its own", (g) => edit(g, "rg-${var.name_prefix}", "payments-prod")],
    ["another location", (g) => edit(g, "var.location", '"westeurope"')],
    ["telemetry on", (g) => edit(g, "enable_telemetry = false", "enable_telemetry = true")],
    ["its own tags", (g) => edit(g, "local.tags", '{ owner = "payments" }')],
    ["an input the generator does not write", (g) => g.replace(/\n\}\n$/, '\n  lock = { kind = "CanNotDelete" }\n}\n')],
    ["a nested block", (g) => g.replace(/\n\}\n$/, "\n  timeouts {\n  }\n}\n")],
    ["no version", (g) => g.replace(/\n\s*version\s+= "[^"]+"/, "")],
  ];
  for (const [label, change] of nearMisses) {
    it(`draws a group with ${label}`, () => {
      assert.deepEqual(hidden(GROUP(change(group))), [], label);
    });
  }

  it("draws a group that is another source", () => {
    assert.deepEqual(hidden(GROUP(edit(group, "Azure/avm-res-resources-resourcegroup/azurerm", "Azure/avm-res-resources-other/azurerm"))), []);
  });

  it("shows a real resource group as a block of the diagram instead of dropping it", () => {
    const real = edit(group, "rg-${var.name_prefix}", "payments-prod");
    const parsed = parseTerraform(GROUP(real));
    assert.ok(parsed.ok);
    assert.ok(parsed.model.nodes.some((n) => n.label.includes("resource_group")));
  });
});

describe("only the network the generator adds is hidden", () => {
  const network = moduleText(AZURE, "network");
  const NETWORK = (body: string) => `${moduleText(AZURE, "resource_group")}\n${body}\n${USES("network", "resource_group")}`;

  it("hides the plan's network when a component uses it", () => {
    assert.deepEqual(hidden(NETWORK(network)), ["resource_group", "network"]);
  });

  it("draws the plan's network when nothing uses it", () => {
    assert.deepEqual(hidden(`${moduleText(AZURE, "resource_group")}\n${USES("resource_group")}\n${network}`), ["resource_group"]);
  });

  const nearMisses: Array<[string, (n: string) => string]> = [
    ["a name of its own", (n) => edit(n, "vnet-${var.name_prefix}", "vnet-payments")],
    ["its own address space", (n) => edit(n, "10.0.0.0/16", "10.20.0.0/16")],
    ["another group", (n) => n.replace(/parent_id\s+= module\.resource_group\.resource_id/, 'parent_id = "/subscriptions/x/resourceGroups/y"')],
    ["a peering the generator does not write", (n) => n.replace(/\n\}\n$/, "\n  peerings = {}\n}\n")],
    ["a subnet the generator would not name", (n) => withoutSubnets(n).replace(/\n\}\n$/, '\n  subnets = {\n    app = {\n      name = "app"\n      address_prefix = "10.0.1.0/24"\n    }\n  }\n}\n')],
    ["a subnet that is not a /24", (n) => withoutSubnets(n).replace(/\n\}\n$/, '\n  subnets = {\n    app = {\n      name = "snet-app"\n      address_prefix = "10.0.0.0/8"\n    }\n  }\n}\n')],
  ];
  for (const [label, change] of nearMisses) {
    it(`draws a network with ${label}`, () => {
      assert.ok(!hidden(NETWORK(change(network))).includes("network"), label);
    });
  }

  it("draws a virtual network of the file's own that happens to be called network", () => {
    const own = `module "network" {
  source        = "Azure/avm-res-network-virtualnetwork/azurerm"
  version       = "0.17.1"
  name          = "vnet-\${var.name_prefix}-network"
  parent_id     = module.resource_group.resource_id
  location      = module.resource_group.location
  address_space = ["10.0.0.0/16"]
  subnets = {
    app = {
      name           = "app"
      address_prefix = "10.0.0.0/24"
    }
  }
  enable_telemetry = false
  tags             = local.tags
}
`;
    const source = `${moduleText(AZURE, "resource_group")}\n${own}\n${USES("network")}`;
    assert.ok(!hidden(source).includes("network"));
    const parsed = parseTerraform(source);
    assert.ok(parsed.ok);
    assert.ok(parsed.model.nodes.some((n) => n.kind === "vnet"));
  });
});

describe("only the private DNS zones the generator adds are hidden", () => {
  const zone = moduleText(AZURE, "private_dns_vaultcore");
  const base = `${moduleText(AZURE, "resource_group")}\n${moduleText(AZURE, "network")}\n`;
  const used = (label: string) => USES(label, "resource_group");

  it("hides a zone a component reads, linked to a network in the file", () => {
    assert.ok(hidden(`${base}${zone}\n${used("private_dns_vaultcore")}`).includes("private_dns_vaultcore"));
  });

  it("draws a zone nothing reads", () => {
    assert.ok(!hidden(`${base}${zone}`).includes("private_dns_vaultcore"));
  });

  it("draws a zone linked to a network the file does not have", () => {
    const source = `${moduleText(AZURE, "resource_group")}\n${zone}\n${used("private_dns_vaultcore")}`;
    assert.ok(!hidden(source).includes("private_dns_vaultcore"));
  });

  const nearMisses: Array<[string, (z: string) => string]> = [
    ["a name that is not its domain's", (z) => z.replace('"private_dns_vaultcore"', '"keys_dns"')],
    ["a domain that is not private link", (z) => edit(z, "privatelink.vaultcore.azure.net", "corp.example.com")],
    ["autoregistration on", (z) => z.replace(/autoregistration\s+= false/, "autoregistration = true")],
    ["another group", (z) => z.replace(/parent_id\s+= module\.resource_group\.resource_id/, 'parent_id = "/subscriptions/x/resourceGroups/y"')],
    ["another link name", (z) => z.replace(/name\s+= "private-dns-vaultcore-link"/, 'name = "to-hub"')],
    ["an input the generator does not write", (z) => z.replace(/\n\}\n$/, '\n  a_records = {}\n}\n')],
  ];
  for (const [label, change] of nearMisses) {
    it(`draws a zone with ${label}`, () => {
      const changed = change(zone);
      const name = /module "([^"]+)"/.exec(changed)?.[1] ?? "";
      assert.ok(!hidden(`${base}${changed}\n${used(name)}`).includes(name), label);
    });
  }
});

describe("only the log bucket the generator adds for a bucket is hidden", () => {
  const logs = moduleText(AWS, "object_storage_logs");
  const bucket = moduleText(AWS, "object_storage");

  it("hides the log bucket of a bucket, and not the bucket", () => {
    assert.deepEqual(hidden(`${bucket}\n${logs}`), ["object_storage_logs"]);
  });

  it("hides both log buckets of a plan and counts the two buckets that remain", () => {
    assert.deepEqual(hidden(AWS).sort(), ["object_storage_logs", "static_site_logs"]);
    const parsed = parseTerraform(AWS);
    assert.ok(parsed.ok);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "object-storage" || n.kind === "static-site").length, 2);
  });

  it("draws a bucket that takes the access-log policy but is logged into by nothing", () => {
    assert.deepEqual(hidden(logs), []);
    const parsed = parseTerraform(logs);
    assert.ok(parsed.ok);
    assert.equal(parsed.model.nodes.filter((n) => n.kind === "object-storage").length, 1);
  });

  const nearMisses: Array<[string, (l: string) => string]> = [
    ["a bucket of its own name", (l) => edit(l, "logs-${var.name_prefix}-object-storage", "audit-trail")],
    ["objects that may be public", (l) => edit(l, "block_public_policy      = true", "block_public_policy      = false")],
    ["a key of its own", (l) => edit(l, '"AES256"', '"aws:kms"')],
    ["a lifecycle the generator does not write", (l) => l.replace(/\n\}\n$/, '\n  lifecycle_rule = []\n}\n')],
    ["versioning off", (l) => edit(l, "enabled = true", "enabled = false")],
    ["another bucket's logs", (l) => edit(l, "[module.object_storage.s3_bucket_arn]", "[module.static_site.s3_bucket_arn, module.object_storage.s3_bucket_arn]")],
    ["another bucket logging into it", (l) => edit(l, "[module.object_storage.s3_bucket_arn]", "[module.somewhere_else.s3_bucket_arn]")],
  ];
  for (const [label, change] of nearMisses) {
    it(`draws a log bucket with ${label}`, () => {
      assert.deepEqual(hidden(`${bucket}\n${change(logs)}`), [], label);
    });
  }

  it("draws a log bucket the bucket does not name as its logging target", () => {
    assert.deepEqual(hidden(`${edit(bucket, "module.object_storage_logs.s3_bucket_id", "module.elsewhere.s3_bucket_id")}\n${logs}`), []);
    assert.deepEqual(hidden(`${edit(bucket, 'target_prefix = "access/"', 'target_prefix = "mine/"')}\n${logs}`), []);
  });

  it("draws a log bucket that is not named for a bucket module of the file", () => {
    assert.deepEqual(hidden(`${bucket}\n${logs.replace('"object_storage_logs"', '"audit_logs"')}`), []);
  });

  it("draws a bucket that is itself the one whose logs are written", () => {
    const nested = logs.replace('"object_storage_logs"', '"object_storage_logs_logs"').replace(/module\.object_storage\.s3_bucket_arn/, "module.object_storage_logs.s3_bucket_arn");
    assert.ok(!hidden(`${bucket}\n${logs}\n${nested}`).includes("object_storage_logs_logs"));
  });

  it("draws a bucket with the policy from another module source", () => {
    assert.deepEqual(hidden(`${bucket}\n${edit(logs, "terraform-aws-modules/s3-bucket/aws", "terraform-aws-modules/s3-object/aws")}`), []);
  });
});

describe("what a plan writes for the other clouds' near-misses stays out of the way", () => {
  it("hides no module in a block list that has none of the plan's", () => {
    const blocks: HclBlock[] = parseHcl('module "x" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n');
    assert.equal(isScaffoldModule(blocks[0] as HclBlock, blocks), false);
  });
});

describe("the subnets a hidden network carries are read, not assumed", () => {
  const network = moduleText(AZURE, "network");
  const subnets = /\n {2}subnets = \{[\s\S]*?\n {2}\}\n/.exec(network)?.[0] ?? "";
  const NETWORK = (body: string) => `${moduleText(AZURE, "resource_group")}\n${body}\n${USES("network", "resource_group")}`;
  const withSubnets = (value: string) => network.replace(subnets, `\n  subnets = ${value}\n`);

  it("hides the network with the subnets the generator writes", () => {
    assert.ok(subnets.length > 0);
    assert.ok(hidden(NETWORK(network)).includes("network"));
  });

  it("hides a network the plan has not given subnets yet", () => {
    assert.ok(hidden(NETWORK(withoutSubnets(network))).includes("network"));
  });

  const unreadable: Array<[string, string]> = [
    ["a reference", "var.subnets"],
    ["a merge", "merge({}, var.subnets)"],
    ["a merge that holds the generator's own", `merge(${/\{[\s\S]*\}/.exec(subnets)?.[0] ?? "{}"}, var.more)`],
    ["a for expression", "{ for name, cidr in var.subnets : name => { name = name, address_prefix = cidr } }"],
    ["a conditional", "var.enabled ? {} : var.subnets"],
    ["no subnet at all", "{}"],
    ["an object with something after it", '{ app = { name = "snet-app", address_prefix = "10.0.1.0/24" } }.app'],
    ["a subnet that is a reference", "{ app = var.app_subnet }"],
    ["a subnet that is a call", '{ app = merge({ name = "snet-app", address_prefix = "10.0.1.0/24" }, var.extra) }'],
    ["a subnet with an input of the file's own", '{ app = { name = "snet-app", address_prefix = "10.0.1.0/24", network_security_group = { id = var.nsg } } }'],
  ];
  for (const [label, value] of unreadable) {
    it(`draws a network whose subnets are ${label}`, () => {
      assert.notEqual(withSubnets(value), network, "the generator's subnets are replaced");
      assert.ok(withSubnets(value).trimEnd().endsWith("}"), "and the module is still closed");
      assert.ok(!hidden(NETWORK(withSubnets(value))).includes("network"), label);
      const parsed = parseTerraform(NETWORK(withSubnets(value)));
      assert.ok(parsed.ok);
      assert.ok(parsed.model.nodes.some((n) => n.kind === "vnet"), label);
    });
  }
});

describe("what keeps the plan's modules hidden is a drawn block that reads them", () => {
  const group = moduleText(AZURE, "resource_group");
  const network = moduleText(AZURE, "network");
  const zone = moduleText(AZURE, "private_dns_vaultcore");
  const PLAN = `${group}\n${network}\n${zone}\n`;

  const notUsers: Array<[string, string]> = [
    ["an output", 'output "group" {\n  value = module.resource_group.resource_id\n}\n'],
    ["a local", "locals {\n  group = module.resource_group.resource_id\n}\n"],
    ["a variable's default", 'variable "group" {\n  default = module.resource_group.resource_id\n}\n'],
    ["a data source nothing draws", 'data "azurerm_client_config" "current" {\n  tenant_id = module.resource_group.resource_id\n}\n'],
    ["a resource no kind reads", 'resource "azurerm_unheard_of" "x" {\n  group = module.resource_group.resource_id\n}\n'],
    ["a module that only has the words in a string", 'module "mine" {\n  source = "Azure/avm-res-storage-storageaccount/azurerm"\n  version = "0.6.8"\n  note = "module.resource_group.resource_id"\n}\n'],
    ["a quoted address in a list", 'module "mine" {\n  source = "Azure/avm-res-storage-storageaccount/azurerm"\n  version = "0.6.8"\n  notes = ["see module.resource_group.resource_id", "module.network.resource_id"]\n}\n'],
    ["a heredoc", 'module "mine" {\n  source = "Azure/avm-res-storage-storageaccount/azurerm"\n  version = "0.6.8"\n  note = <<-EOT\n    module.resource_group.resource_id\n  EOT\n}\n'],
  ];
  for (const [label, text] of notUsers) {
    it(`draws the group and the network when only ${label} names them`, () => {
      const names = hidden(`${PLAN}${text}`);
      assert.ok(!names.includes("resource_group"), label);
      assert.ok(!names.includes("network"), label);
    });
  }

  it("draws the network and the zone when the only block that reads the zone is an output", () => {
    const names = hidden(`${PLAN}${USES("resource_group")}output "z" {\n  value = module.private_dns_vaultcore.resource_id\n}\n`);
    assert.ok(!names.includes("private_dns_vaultcore"));
    assert.ok(!names.includes("network"));
    assert.ok(names.includes("resource_group"));
  });

  it("keeps hiding a module a drawn block reads through an interpolation, in a resource or in a module", () => {
    const interpolated = 'module "mine" {\n  source = "Azure/avm-res-storage-storageaccount/azurerm"\n  version = "0.6.8"\n  note = "${module.resource_group.resource_id}"\n}\n';
    assert.ok(hidden(`${PLAN}${interpolated}`).includes("resource_group"));
    const resource = 'resource "azurerm_storage_account" "mine" {\n  name = "x"\n  resource_group_name = module.resource_group.name\n}\n';
    assert.ok(hidden(`${group}\n${resource}`).includes("resource_group"));
  });

  it("is not kept hidden by a module that is itself the plan's", () => {
    // The zone reads the group, and the network reads it; none of them is a component, so none keeps the group hidden.
    assert.deepEqual(hidden(PLAN), []);
  });
});

describe("only the private DNS zones the generator writes are hidden, whatever else is exact", () => {
  const base = `${moduleText(AZURE, "resource_group")}\n${moduleText(AZURE, "network")}\n`;
  const zone = moduleText(AZURE, "private_dns_vaultcore");
  const anotherZone = (domain: string, label: string) =>
    zone.replace('"private_dns_vaultcore"', `"${label}"`).replace("privatelink.vaultcore.azure.net", domain).replace("private-dns-vaultcore-link", `${label.replace(/_/g, "-")}-link`);

  it("hides the three the generator writes, one for each service behind a private endpoint", () => {
    for (const domain of ["privatelink.vaultcore.azure.net", "privatelink.postgres.database.azure.com", "privatelink.mysql.database.azure.com"]) {
      const label = `private_dns_${domain.replace(/^privatelink\./, "").split(".")[0]}`;
      assert.ok(hidden(`${base}${anotherZone(domain, label)}\n${USES(label)}`).includes(label), domain);
    }
  });

  it("draws a zone of a private link domain the generator never writes, however exactly it is otherwise written", () => {
    for (const [domain, label] of [
      ["privatelink.blob.core.windows.net", "private_dns_blob"],
      ["privatelink.database.windows.net", "private_dns_database"],
      ["privatelink.azure.net", "private_dns_azure"],
      ["privatelink.vaultcore.azure.net.evil.example", "private_dns_vaultcore"],
    ] as const) {
      assert.ok(!hidden(`${base}${anotherZone(domain, label)}\n${USES(label)}`).includes(label), domain);
    }
  });
});
