// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkAzureSkus, SKU_PATTERNS, SKU_RULE_IDS } from "terragram-engine/azure-sku";
import { AZURE_SKU_DATA } from "terragram-engine/azure-sku-data";
import { composeFromPrompt } from "terragram-engine/engine";
import { CLOUDS } from "terragram-engine/model";
import { emitTerraform } from "terragram-engine/terraform";
import { templateModel, WORKSPACE_TEMPLATES } from "terragram-engine/templates";

import { BRIEFS } from "../scripts/emit-briefs.ts";

/**
 * The SKU check reads Terraform and the checked-in data file; it never calls Azure.
 * Region facts are taken from the data file itself, so a refresh that moves a region
 * in or out of a SKU's list does not break these.
 */

const DATE = AZURE_SKU_DATA.refreshed;

const tf = (content: string) => [{ name: "main.tf", content }];

const plan = (location: string, sku: string, extra = "") => `
variable "location" {
  type    = string
  default = "${location}"
}

module "web_plan" {
  source   = "Azure/avm-res-web-serverfarm/azurerm"
  name     = "asp"
  location = var.location
  sku_name = "${sku}"
${extra}}
`;

/** A SKU the price list sells in some regions and not others, and one region of each kind. */
function partlySold(ruleId: string): { sku: string; sold: string; missing: string } {
  const available = AZURE_SKU_DATA.rules[ruleId]?.available;
  assert.ok(available, `${ruleId} has region data`);
  for (const [sku, index] of Object.entries(available.skus)) {
    const missing = available.sets[index]?.[0];
    const sold = AZURE_SKU_DATA.regions.find((r) => !available.sets[index]?.includes(r));
    if (missing !== undefined && sold !== undefined) return { sku, sold, missing };
  }
  throw new Error(`${ruleId}: no SKU is sold in only some regions`);
}

describe("Azure SKU check", () => {
  it("passes a valid SKU in a region that sells it", () => {
    assert.deepEqual(checkAzureSkus(tf(plan("uksouth", "P1v3"))), []);
    assert.deepEqual(checkAzureSkus(tf(plan("UK South", "P1v3"))), [], "a display name is the same region");
  });

  it("warns about a SKU the provider does not document, naming the data date", () => {
    const [finding, ...rest] = checkAzureSkus(tf(plan("uksouth", "P9v9")));
    assert.equal(rest.length, 0);
    assert.equal(finding?.severity, "warning");
    assert.equal(finding?.rule, "app-service-plan");
    assert.equal(finding?.address, "module.web_plan");
    assert.match(finding?.message ?? "", /"P9v9" is not a known App Service plan SKU/);
    assert.ok(finding?.message.includes(`data of ${DATE}`));
  });

  it("does not also judge the region of a SKU that does not exist", () => {
    const findings = checkAzureSkus(tf(plan("marsnorth", "P9v9")));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "app-service-plan");
  });

  it("warns when the region has no price for a valid SKU", () => {
    const { sku, sold, missing } = partlySold("storage-account");
    const storage = (region: string) => `
module "data" {
  source           = "Azure/avm-res-storage-storageaccount/azurerm"
  location         = "${region}"
  account_sku_name = "${sku}"
}
`;
    assert.deepEqual(checkAzureSkus(tf(storage(sold))), []);
    const [finding] = checkAzureSkus(tf(storage(missing)));
    assert.equal(finding?.severity, "warning");
    assert.match(finding?.message ?? "", new RegExp(`"${sku}" has no price in ${missing}`));
    assert.ok(finding?.message.includes(`data of ${DATE}`));
  });

  it("warns once, naming every block, for a region the data does not know", () => {
    const content = `${plan("marsnorth", "P1v3")}
module "cache" {
  source   = "Azure/avm-res-cache-redis/azurerm"
  location = "marsnorth"
  sku_name = "Standard"
}
`;
    const findings = checkAzureSkus(tf(content));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.rule, "region");
    assert.equal(findings[0]?.address, "module.cache, module.web_plan");
    assert.match(findings[0]?.message ?? "", /location "marsnorth" is not a region/);
    assert.ok(findings[0]?.message.includes(`data of ${DATE}`));
  });

  it("follows a location through a variable and the resource group module", () => {
    const content = `
variable "location" {
  default = "marsnorth"
}

module "resource_group" {
  source   = "Azure/avm-res-resources-resourcegroup/azurerm"
  location = var.location
}

module "cache" {
  source   = "Azure/avm-res-cache-redis/azurerm"
  location = module.resource_group.location
  sku_name = "Standard"
}
`;
    assert.equal(checkAzureSkus(tf(content))[0]?.rule, "region");
  });

  it("skips a value it cannot read instead of guessing", () => {
    const content = `
variable "location" {
  type = string
}

variable "sku" {
  type = string
}

module "web_plan" {
  source   = "Azure/avm-res-web-serverfarm/azurerm"
  location = var.location
  sku_name = var.sku
}

module "cache" {
  source   = "Azure/avm-res-cache-redis/azurerm"
  location = var.location
  sku_name = "Standard"
}
`;
    assert.deepEqual(checkAzureSkus(tf(content)), []);
  });

  it("matches a SKU ignoring case, as Azure does for a Key Vault", () => {
    const vault = `
module "kv" {
  source   = "Azure/avm-res-keyvault-vault/azurerm"
  location = "uksouth"
  sku_name = "Standard"
}
`;
    assert.deepEqual(checkAzureSkus(tf(vault)), []);
  });

  it("checks raw azurerm resources, a storage account's SKU being its tier and replication", () => {
    const raw = (tier: string, replication: string) => `
resource "azurerm_storage_account" "data" {
  location                 = "uksouth"
  account_tier             = "${tier}"
  account_replication_type = "${replication}"
}
`;
    assert.deepEqual(checkAzureSkus(tf(raw("Standard", "GRS"))), []);
    const [finding] = checkAzureSkus(tf(raw("Premium", "GRS")));
    assert.equal(finding?.address, "azurerm_storage_account.data");
    assert.match(finding?.message ?? "", /"Premium_GRS" is not a known storage account SKU/);
  });

  it("checks a database SKU by the documented tier + name pattern", () => {
    const pg = (sku: string) => `
module "db" {
  source   = "Azure/avm-res-dbforpostgresql-flexibleserver/azurerm"
  location = "uksouth"
  sku_name = "${sku}"
}
`;
    assert.deepEqual(checkAzureSkus(tf(pg("GP_Standard_D2s_v3"))), []);
    assert.deepEqual(checkAzureSkus(tf(pg("B_Standard_B1ms"))), []);
    assert.equal(checkAzureSkus(tf(pg("D2s_v3")))[0]?.rule, "postgres-flexible");
  });

  it("leaves everything that is not an Azure SKU alone", () => {
    const other = `
resource "aws_instance" "web" {
  instance_type = "t99.nonsense"
  sku_name      = "P9v9"
}

resource "google_compute_instance" "vm" {
  machine_type = "n99-nonsense"
  sku_name     = "P9v9"
}

resource "azurerm_linux_virtual_machine" "vm" {
  location = "marsnorth"
  size     = "Standard_Nonsense"
  sku_name = "P9v9"
}

module "plan" {
  source   = "someone/else/azurerm"
  location = "marsnorth"
  sku_name = "P9v9"
}
`;
    assert.deepEqual(checkAzureSkus(tf(other)), []);
    assert.deepEqual(checkAzureSkus([{ name: "notes.txt", content: plan("uksouth", "P9v9") }]), [], "only .tf files");
    assert.deepEqual(checkAzureSkus([]), []);
  });

  it("gives the same findings whatever order the files are in", () => {
    const files = [
      { name: "main.tf", content: plan("uksouth", "P9v9") },
      { name: "extra.tf", content: 'module "cache" {\n  source   = "Azure/avm-res-cache-redis/azurerm"\n  location = "marsnorth"\n  sku_name = "Nope"\n}\n' },
    ];
    assert.deepEqual(checkAzureSkus(files), checkAzureSkus(files.toReversed()));
    assert.equal(checkAzureSkus(files).length, 2);
  });

  it("finds nothing wrong in anything the emitter writes", () => {
    const models = [
      ...BRIEFS.map((brief) => composeFromPrompt(brief).model),
      ...WORKSPACE_TEMPLATES.map((template) => templateModel(template)),
    ];
    let checked = 0;
    for (const model of models) {
      for (const cloud of CLOUDS) {
        const out = emitTerraform(model, cloud);
        assert.deepEqual(checkAzureSkus(out.files), [], `${cloud} output`);
        if (cloud === "azure") checked += out.files.length;
      }
    }
    assert.ok(checked > 0);
  });

  it("has data for every rule it applies", () => {
    for (const id of SKU_RULE_IDS) {
      const rule = AZURE_SKU_DATA.rules[id];
      assert.ok(rule, `${id} is in the data`);
      assert.ok(rule.valid.length > 0 || rule.pattern !== undefined, `${id} has a way to tell a valid SKU`);
      if (rule.pattern !== undefined) assert.ok(Object.hasOwn(SKU_PATTERNS, rule.pattern), `${id}: pattern ${rule.pattern} has a compiled literal`);
    }
    assert.deepEqual(Object.keys(AZURE_SKU_DATA.rules).sort(), [...SKU_RULE_IDS].sort());
    assert.match(AZURE_SKU_DATA.refreshed, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(AZURE_SKU_DATA.regions.includes("uksouth"));
  });
});
