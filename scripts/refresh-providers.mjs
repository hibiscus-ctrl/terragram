#!/usr/bin/env node
// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refresh the provider version constraints and the registry module pins the
 * Terraform emitter writes.
 *
 * Run it by hand ahead of a release or from the scheduled workflow
 * (.github/workflows/refresh-pins.yml) — never at request time. Generated emission
 * must not depend on a network call: a registry outage would change the plan a
 * reviewer sees, and the whole point of the emitter is that it is deterministic.
 *
 *   npm run refresh:providers
 *
 * Writes `packages/engine/src/provider-versions.ts` and
 * `packages/engine/src/module-versions.ts`. They are .ts files rather than
 * JSON so that Node's type-stripping test runner, Turbopack and tsc all read them
 * the same way with no import attributes.
 *
 * Providers pin `~> major.minor`; modules pin an EXACT version, because a module
 * call is code Terragram did not write and the evidence receipt records which.
 *
 * Every pin stays on the major version it is on now (for a 0.x module, the same minor
 * version): a major release can rename or remove inputs, which is a change to the
 * emitter, so it is made by hand. A file whose
 * pins did not change is left alone (its refreshed date included), so a run with
 * nothing new leaves the tree clean.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MODULE_VERSIONS, MODULE_VERSIONS_REFRESHED } from "../packages/engine/src/module-versions.ts";
import { PROVIDER_VERSIONS, PROVIDER_VERSIONS_REFRESHED } from "../packages/engine/src/provider-versions.ts";
import { newestOnLine, renderModuleFile, renderProviderFile } from "./lib/pins.mjs";

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

/** The version in a pin such as `~> 6.64` or `5.18.0`. */
const versionOf = (pin) => /\d+(\.\d+)*/.exec(pin)?.[0] ?? "";

/**
 * A provider stays on the major line its pin is on (see the header). azurerm is held on
 * 4.x on purpose, and has to stay there until the Azure Verified Modules the emitter
 * calls accept 5.x: they constrain it to `< 5.0` / `< 5.1` across the set, so a root on
 * 5.x would not initialise. The registry's latest azurerm is a major ahead of this, and
 * moving to it is a decision about the AVM set, not a refresh. Moving the AWS provider
 * to a new major is a by-hand change too (edit the pin, then run this).
 */
const PROVIDERS = [
  { cloud: "azure", name: "azurerm", source: "hashicorp/azurerm" },
  { cloud: "aws", name: "aws", source: "hashicorp/aws" },
  // Google Cloud plans are raw resources, so the provider has no module to wait for; the
  // archive provider packages a function's source for upload.
  { cloud: "gcp", name: "google", source: "hashicorp/google" },
  { cloud: "gcp-beta", name: "google-beta", source: "hashicorp/google-beta" },
  { cloud: "archive", name: "archive", source: "hashicorp/archive" },
].map((p) => ({ ...p, pin: versionOf(PROVIDER_VERSIONS[p.cloud].version) }));

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

async function latestProvider(source, pin) {
  const body = await registryJson(`${REGISTRY}/${source}/versions`);
  return newestOnLine(source, (body.versions ?? []).map((v) => v.version), pin);
}

async function latestModule(source, pin) {
  const body = await registryJson(`${MODULE_REGISTRY}/${source}/versions`);
  const versions = (body.modules ?? []).flatMap((m) => (m.versions ?? []).map((v) => v.version));
  return newestOnLine(source, versions, pin);
}

/** Write `content(date)` unless it equals what is there with the date it already has. */
async function writeIfChanged(target, current, content) {
  const before = await readFile(target, "utf8");
  if (content(current) === before) {
    console.log(`unchanged ${target}`);
    return;
  }
  await writeFile(target, content(today), "utf8");
  console.log(`wrote ${target}`);
}

const resolved = [];
for (const provider of PROVIDERS) {
  const version = await latestProvider(provider.source, provider.pin);
  resolved.push({ ...provider, version, constraint: constraintFor(version) });
  console.log(`${provider.source} -> ${version} (${constraintFor(version)})`);
}

const today = new Date().toISOString().slice(0, 10);
const file = (date) => renderProviderFile(date, resolved);

const target = fileURLToPath(
  new URL("../packages/engine/src/provider-versions.ts", import.meta.url),
);
await writeIfChanged(target, PROVIDER_VERSIONS_REFRESHED, file);

const modulePins = [];
for (const mod of MODULES) {
  const version = await latestModule(mod.source, MODULE_VERSIONS[mod.key].version);
  modulePins.push({ ...mod, version });
  console.log(`${mod.source} -> ${version} (exact)`);
}

const moduleFile = (date) => renderModuleFile(date, modulePins);

const moduleTarget = fileURLToPath(
  new URL("../packages/engine/src/module-versions.ts", import.meta.url),
);
await writeIfChanged(moduleTarget, MODULE_VERSIONS_REFRESHED, moduleFile);
