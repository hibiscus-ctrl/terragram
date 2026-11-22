#!/usr/bin/env node
// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refresh the provider version constraints and the registry module pins the
 * Terraform emitter writes.
 *
 * Run it by hand ahead of a release — never at request time. Generated emission
 * must not depend on a network call: a registry outage would change the plan a
 * reviewer sees, and the whole point of the emitter is that it is deterministic.
 *
 *   npm run refresh:providers
 *
 * Writes `src/features/workspace/provider-versions.ts` and
 * `src/features/workspace/module-versions.ts`. They are .ts files rather than
 * JSON so that Node's type-stripping test runner, Turbopack and tsc all read them
 * the same way with no import attributes.
 *
 * Providers pin `~> major.minor`; modules pin an EXACT version, because a module
 * call is code Terragram did not write and the evidence receipt records which.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.terraform.io/v1/providers";
const MODULE_REGISTRY = "https://registry.terraform.io/v1/modules";

/** Key = how kinds.ts refers to the module; source = the registry address. */
const MODULES = [
  // Azure Verified Modules — Microsoft's maintained resource modules, one per kind.
  { key: "azure/resource-group", source: "Azure/avm-res-resources-resourcegroup/azurerm" },
  { key: "azure/dns-zone", source: "Azure/avm-res-network-dnszone/azurerm" },
  { key: "azure/cdn-profile", source: "Azure/avm-res-cdn-profile/azurerm" },
  { key: "azure/load-balancer", source: "Azure/avm-res-network-loadbalancer/azurerm" },
  { key: "azure/service-plan", source: "Azure/avm-res-web-serverfarm/azurerm" },
  { key: "azure/web-site", source: "Azure/avm-res-web-site/azurerm" },
  { key: "azure/container-environment", source: "Azure/avm-res-app-managedenvironment/azurerm" },
  { key: "azure/container-app", source: "Azure/avm-res-app-containerapp/azurerm" },
  { key: "azure/static-site", source: "Azure/avm-res-web-staticsite/azurerm" },
  { key: "azure/servicebus", source: "Azure/avm-res-servicebus-namespace/azurerm" },
  { key: "azure/virtual-network", source: "Azure/avm-res-network-virtualnetwork/azurerm" },
  { key: "azure/private-dns-zone", source: "Azure/avm-res-network-privatednszone/azurerm" },
  { key: "azure/redis", source: "Azure/avm-res-cache-redis/azurerm" },
  { key: "azure/postgres", source: "Azure/avm-res-dbforpostgresql-flexibleserver/azurerm" },
  { key: "azure/mysql", source: "Azure/avm-res-dbformysql-flexibleserver/azurerm" },
  { key: "azure/cosmos", source: "Azure/avm-res-documentdb-databaseaccount/azurerm" },
  { key: "azure/storage-account", source: "Azure/avm-res-storage-storageaccount/azurerm" },
  { key: "azure/user-assigned-identity", source: "Azure/avm-res-managedidentity-userassignedidentity/azurerm" },
  { key: "azure/key-vault", source: "Azure/avm-res-keyvault-vault/azurerm" },
  { key: "azure/log-analytics", source: "Azure/avm-res-operationalinsights-workspace/azurerm" },
  { key: "azure/app-insights", source: "Azure/avm-res-insights-component/azurerm" },
  // terraform-aws-modules — the community-maintained equivalents on AWS.
  { key: "aws/lambda", source: "terraform-aws-modules/lambda/aws" },
  { key: "aws/s3-bucket", source: "terraform-aws-modules/s3-bucket/aws" },
  { key: "aws/sqs", source: "terraform-aws-modules/sqs/aws" },
  { key: "aws/dynamodb-table", source: "terraform-aws-modules/dynamodb-table/aws" },
  { key: "aws/rds", source: "terraform-aws-modules/rds/aws" },
  { key: "aws/vpc", source: "terraform-aws-modules/vpc/aws" },
  { key: "aws/route53", source: "terraform-aws-modules/route53/aws" },
  { key: "aws/elasticache", source: "terraform-aws-modules/elasticache/aws" },
  { key: "aws/cloudwatch", source: "terraform-aws-modules/cloudwatch/aws" },
  { key: "aws/alb", source: "terraform-aws-modules/alb/aws" },
  { key: "aws/ecs", source: "terraform-aws-modules/ecs/aws" },
  { key: "aws/ec2-instance", source: "terraform-aws-modules/ec2-instance/aws" },
];

/**
 * `major` holds a provider on a major line. The Azure Verified Modules the emitter
 * calls pin `azurerm` to 4.x (`< 5.0` / `< 5.1` across the set), so the root
 * follows the newest 4.x rather than the registry's latest; the AWS modules
 * accept the current major. Drop the pin when the AVM set moves.
 */
const PROVIDERS = [
  { cloud: "azure", name: "azurerm", source: "hashicorp/azurerm", major: 4 },
  { cloud: "aws", name: "aws", source: "hashicorp/aws" },
];

/** `5.5.0` -> `~> 5.5` — pin the major, allow the minor to float. */
function constraintFor(version) {
  const [major, minor] = version.split(".");
  return `~> ${major}.${minor}`;
}

async function registryJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${url}: registry returned ${response.status}`);
  return response.json();
}

async function latest(source, registry = REGISTRY) {
  const body = await registryJson(`${registry}/${source}`);
  if (typeof body.version !== "string") throw new Error(`${source}: no version in response`);
  return body.version;
}

/** Newest release on a major line — final releases only, so no `-beta`. */
async function latestOnMajor(source, major) {
  const body = await registryJson(`${REGISTRY}/${source}/versions`);
  const versions = (body.versions ?? [])
    .map((v) => v.version)
    .filter((v) => {
      const [ma, mi, pa] = v.split(".");
      return Number(ma) === major && /^\d+$/.test(mi ?? "") && /^\d+$/.test(pa ?? "");
    })
    .sort((a, b) => {
      const [, am, ap] = a.split(".").map(Number);
      const [, bm, bp] = b.split(".").map(Number);
      return am - bm || ap - bp;
    });
  const found = versions.at(-1);
  if (!found) throw new Error(`${source}: no ${major}.x release on the registry`);
  return found;
}

const resolved = [];
for (const provider of PROVIDERS) {
  const version = provider.major
    ? await latestOnMajor(provider.source, provider.major)
    : await latest(provider.source);
  resolved.push({ ...provider, version, constraint: constraintFor(version) });
  console.log(`${provider.source} -> ${version} (${constraintFor(version)})`);
}

const today = new Date().toISOString().slice(0, 10);
const entries = resolved
  .map(
    (p) =>
      `  ${p.cloud}: {\n    name: "${p.name}",\n    source: "${p.source}",\n    version: "${p.constraint}",\n  },`,
  )
  .join("\n");

const file = `/**
 * Provider version constraints used by the Terraform emitter.
 *
 * GENERATED by \`npm run refresh:providers\` — do not edit by hand. Refreshed
 * ${today} against registry.terraform.io. The emitter reads this file so that
 * generated plans pin a current provider without the request path ever touching
 * the network.
 */

export type ProviderPin = { name: string; source: string; version: string };

export const PROVIDER_VERSIONS: Record<"azure" | "aws", ProviderPin> = {
${entries}
};

/** When the pins above were last refreshed (ISO date). */
export const PROVIDER_VERSIONS_REFRESHED = "${today}";
`;

const target = fileURLToPath(
  new URL("../src/features/workspace/provider-versions.ts", import.meta.url),
);
await writeFile(target, file, "utf8");
console.log(`wrote ${target}`);

const modulePins = [];
for (const mod of MODULES) {
  const version = await latest(mod.source, MODULE_REGISTRY);
  modulePins.push({ ...mod, version });
  console.log(`${mod.source} -> ${version} (exact)`);
}

const moduleEntries = modulePins
  .map((m) => `  "${m.key}": { source: "${m.source}", version: "${m.version}" },`)
  .join("\n");

const moduleFile = `/**
 * Registry module pins used by the Terraform emitter.
 *
 * GENERATED by \`npm run refresh:providers\` — do not edit by hand. Refreshed
 * ${today} against registry.terraform.io. Modules are pinned to an EXACT version,
 * unlike providers: a module call is code Terragram did not write, and the evidence
 * receipt records which code, so \`~>\` would make the receipt say less than it
 * should. The emitter reads this file so the request path never touches the network.
 */

export type ModulePin = { source: string; version: string };

export const MODULE_VERSIONS = {
${moduleEntries}
} as const satisfies Record<string, ModulePin>;

export type ModuleKey = keyof typeof MODULE_VERSIONS;

/** When the pins above were last refreshed (ISO date). */
export const MODULE_VERSIONS_REFRESHED = "${today}";
`;

const moduleTarget = fileURLToPath(
  new URL("../src/features/workspace/module-versions.ts", import.meta.url),
);
await writeFile(moduleTarget, moduleFile, "utf8");
console.log(`wrote ${moduleTarget}`);
