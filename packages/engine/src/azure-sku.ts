// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { AZURE_SKU_DATA, type SkuRuleData } from "./azure-sku-data.ts";
import { attributeOf, type HclBlock, parseHcl, stringValue } from "./hcl.ts";
import type { TerraformFile } from "./terraform.ts";

/**
 * Does the Azure plan name a SKU that exists, and one the region sells?
 *
 * Reads the Terraform the emitter wrote (or any azurerm Terraform) and checks each
 * SKU argument of the resource types Terragram emits against `azure-sku-data.ts`: the
 * names the azurerm provider documents, and the regions that have a price for the SKU.
 * Nothing here reaches the network. The data is a dated snapshot, so every finding
 * names its date and is a warning, never an error: a SKU Azure added since is "not
 * known", not wrong.
 *
 * Values that are not a plain string (a variable without a default, an interpolation)
 * are skipped rather than guessed at. Resources of any other provider are never read.
 */

export type SkuFinding = {
  severity: "warning";
  /** The data rule that raised it, e.g. `app-service-plan`. */
  rule: string;
  /** `module.name` or `type.name` of the block, or the blocks sharing an unknown region. */
  address: string;
  message: string;
};

type Binding = {
  rule: string;
  /** What to call the thing in a message. */
  label: string;
  /** Registry module source, or null for a raw resource only. */
  module: string | null;
  resource: string | null;
  /** The SKU argument on the module and on the resource. */
  moduleAttribute: string;
  resourceAttribute: string;
};

/** The SKU-bearing arguments of every Azure kind the emitter writes, as a module or a raw resource. */
const BINDINGS: readonly Binding[] = [
  {
    rule: "app-service-plan",
    label: "App Service plan",
    module: "Azure/avm-res-web-serverfarm/azurerm",
    resource: "azurerm_service_plan",
    moduleAttribute: "sku_name",
    resourceAttribute: "sku_name",
  },
  {
    rule: "redis-cache",
    label: "Redis cache",
    module: "Azure/avm-res-cache-redis/azurerm",
    resource: "azurerm_redis_cache",
    moduleAttribute: "sku_name",
    resourceAttribute: "sku_name",
  },
  {
    // A raw resource splits the SKU in two (`account_tier` + `account_replication_type`).
    rule: "storage-account",
    label: "storage account",
    module: "Azure/avm-res-storage-storageaccount/azurerm",
    resource: "azurerm_storage_account",
    moduleAttribute: "account_sku_name",
    resourceAttribute: "account_tier+account_replication_type",
  },
  {
    rule: "postgres-flexible",
    label: "PostgreSQL flexible server",
    module: "Azure/avm-res-dbforpostgresql-flexibleserver/azurerm",
    resource: "azurerm_postgresql_flexible_server",
    moduleAttribute: "sku_name",
    resourceAttribute: "sku_name",
  },
  {
    rule: "mysql-flexible",
    label: "MySQL flexible server",
    module: "Azure/avm-res-dbformysql-flexibleserver/azurerm",
    resource: "azurerm_mysql_flexible_server",
    moduleAttribute: "sku_name",
    resourceAttribute: "sku_name",
  },
  {
    rule: "key-vault",
    label: "Key Vault",
    module: "Azure/avm-res-keyvault-vault/azurerm",
    resource: "azurerm_key_vault",
    moduleAttribute: "sku_name",
    resourceAttribute: "sku_name",
  },
  {
    rule: "load-balancer",
    label: "load balancer",
    module: "Azure/avm-res-network-loadbalancer/azurerm",
    resource: "azurerm_lb",
    moduleAttribute: "sku",
    resourceAttribute: "sku",
  },
  {
    rule: "service-bus",
    label: "Service Bus namespace",
    module: "Azure/avm-res-servicebus-namespace/azurerm",
    resource: "azurerm_servicebus_namespace",
    moduleAttribute: "sku",
    resourceAttribute: "sku",
  },
  {
    rule: "front-door",
    label: "Front Door profile",
    module: "Azure/avm-res-cdn-profile/azurerm",
    resource: "azurerm_cdn_frontdoor_profile",
    moduleAttribute: "sku",
    resourceAttribute: "sku_name",
  },
  {
    rule: "log-analytics",
    label: "Log Analytics workspace",
    module: "Azure/avm-res-operationalinsights-workspace/azurerm",
    resource: "azurerm_log_analytics_workspace",
    moduleAttribute: "log_analytics_workspace_sku",
    resourceAttribute: "sku",
  },
];

/** The rule ids this check applies, which the data must carry one entry each for. */
export const SKU_RULE_IDS: readonly string[] = BINDINGS.map((b) => b.rule);

const MAX_REFERENCE_DEPTH = 5;

/** How a region is written in Terraform: "UK South" is `uksouth`. */
function regionKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

type Plan = { variables: Map<string, HclBlock>; modules: Map<string, HclBlock> };

/**
 * The region a `location` expression stands for, when it can be read without running
 * Terraform: a string, a variable's default, or another module's `location` output
 * (the resource group, which is how every emitted resource names its region).
 */
function resolveLocation(expr: string | undefined, plan: Plan, depth = 0): string | undefined {
  if (expr === undefined || depth > MAX_REFERENCE_DEPTH) return undefined;
  const text = expr.trim();
  const literal = stringValue(text);
  if (literal !== undefined) return literal.includes("${") ? undefined : literal;
  const variable = /^var\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(text);
  if (variable) {
    const block = plan.variables.get(variable[1] ?? "");
    return block ? resolveLocation(attributeOf(block, "default"), plan, depth + 1) : undefined;
  }
  const module = /^module\.([A-Za-z_][A-Za-z0-9_-]*)\.location$/.exec(text);
  if (module) {
    const block = plan.modules.get(module[1] ?? "");
    return block ? resolveLocation(attributeOf(block, "location"), plan, depth + 1) : undefined;
  }
  return undefined;
}

/** The SKU a block names, or undefined when it is absent or not a plain string. */
function skuOf(block: HclBlock, binding: Binding): string | undefined {
  if (block.type === "module") return stringValue(attributeOf(block, binding.moduleAttribute));
  const [first, second] = binding.resourceAttribute.split("+");
  const head = stringValue(attributeOf(block, first ?? ""));
  if (second === undefined) return head;
  const tail = stringValue(attributeOf(block, second));
  return head !== undefined && tail !== undefined ? `${head}_${tail}` : undefined;
}

/**
 * The data's SKU patterns, compiled from literals: the data names a pattern by its
 * source text and only the ones listed here are used, so no pattern is built at run
 * time. A test checks every pattern in the data has an entry.
 */
export const SKU_PATTERNS: Readonly<Record<string, RegExp>> = {
  "^(?:B|GP|MO)_Standard_[A-Za-z0-9_]+$": /^(?:B|GP|MO)_Standard_[A-Za-z0-9_]+$/i,
};

function isKnown(rule: SkuRuleData, sku: string): boolean {
  const lower = sku.toLowerCase();
  if (rule.valid.some((v) => v.toLowerCase() === lower)) return true;
  if (rule.pattern === undefined || !Object.hasOwn(SKU_PATTERNS, rule.pattern)) return false;
  return SKU_PATTERNS[rule.pattern]?.test(sku) ?? false;
}

/** The data's own spelling of a SKU, so the availability lookup is exact. */
function canonical(rule: SkuRuleData, sku: string): string {
  const lower = sku.toLowerCase();
  return rule.valid.find((v) => v.toLowerCase() === lower) ?? sku;
}

function notSoldIn(rule: SkuRuleData, sku: string, region: string): boolean {
  const available = rule.available;
  if (!available) return false;
  const index = available.skus[canonical(rule, sku)];
  const sets = available.sets[index ?? -1];
  return sets?.includes(region) === true;
}

/**
 * Warnings for the SKUs and regions in these Terraform files. Deterministic: the same
 * files give the same findings in the same order. Files that are not `.tf` are ignored.
 */
export function checkAzureSkus(files: ReadonlyArray<TerraformFile>): SkuFinding[] {
  const blocks = files.filter((f) => f.name.endsWith(".tf")).flatMap((f) => parseHcl(f.content));
  const plan: Plan = {
    variables: new Map(blocks.filter((b) => b.type === "variable").map((b) => [b.labels[0] ?? "", b])),
    modules: new Map(blocks.filter((b) => b.type === "module").map((b) => [b.labels[0] ?? "", b])),
  };
  const { rules, regions, refreshed } = AZURE_SKU_DATA;
  const known = new Set(regions);
  const findings: SkuFinding[] = [];
  /** Blocks whose region is not one the data knows, grouped by the region as written. */
  const unknownRegion = new Map<string, string[]>();

  for (const block of blocks) {
    const binding =
      block.type === "module"
        ? BINDINGS.find((b) => b.module !== null && b.module === stringValue(attributeOf(block, "source")))
        : block.type === "resource"
          ? BINDINGS.find((b) => b.resource === block.labels[0])
          : undefined;
    const rule = binding && rules[binding.rule];
    if (!binding || !rule) continue;
    const sku = skuOf(block, binding);
    if (sku === undefined) continue;
    const address = block.type === "module" ? `module.${block.labels[0]}` : `${block.labels[0]}.${block.labels[1]}`;

    if (!isKnown(rule, sku)) {
      findings.push({
        severity: "warning",
        rule: binding.rule,
        address,
        message: `${address}: "${sku}" is not a known ${binding.label} SKU (azurerm documentation, data of ${refreshed}); check the spelling, or refresh the SKU data if Azure added it since.`,
      });
      continue;
    }

    const written = resolveLocation(attributeOf(block, "location"), plan);
    if (written === undefined) continue;
    const region = regionKey(written);
    if (!known.has(region)) {
      unknownRegion.set(written, [...(unknownRegion.get(written) ?? []), address]);
    } else if (notSoldIn(rule, sku, region)) {
      findings.push({
        severity: "warning",
        rule: binding.rule,
        address,
        message: `${address}: ${binding.label} SKU "${sku}" has no price in ${region} (Azure retail price list, data of ${refreshed}), so it is probably not offered there; pick another SKU or region.`,
      });
    }
  }

  for (const [written, addresses] of unknownRegion) {
    const list = [...new Set(addresses)].sort();
    findings.push({
      severity: "warning",
      rule: "region",
      address: list.join(", "),
      message: `${list.join(", ")}: location "${written}" is not a region the SKU data knows (data of ${refreshed}), so SKU availability was not checked there.`,
    });
  }

  return findings.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
}
