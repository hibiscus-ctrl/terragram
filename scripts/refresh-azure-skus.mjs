#!/usr/bin/env node
// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refresh the Azure SKU data the SKU check reads (packages/engine/src/azure-sku-data.ts).
 *
 * Run it by hand or from a pull request, never at generate time: the check must not
 * depend on the network. Two public sources, no credentials:
 *
 *  - the azurerm provider documentation at the tag for the pinned provider line
 *    (provider-versions.ts), for which SKU names exist;
 *  - the Azure Retail Prices API, for the regions that sell a SKU. That is the price
 *    list, not the Resource SKUs API (which needs a subscription), so it cannot see
 *    capacity limits or per-subscription restrictions.
 *
 *   npm run refresh:azure-skus
 *
 * Region data is kept only for SKUs Terragram emits or documents a clean price-list
 * name for; every other SKU is checked for validity alone. The file is left alone (its
 * date included) when the data did not change, so a run with nothing new leaves the tree clean.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PROVIDER_VERSIONS } from "../packages/engine/src/provider-versions.ts";
import {
  appServiceSku,
  docValues,
  packAvailability,
  regionKey,
  regionsBySku,
  renderSkuDataFile,
  storageSkuFromPrice,
  storageSkus,
} from "./lib/azure-skus.mjs";

const PRICES = "https://prices.azure.com/api/retail/prices";
const PRICES_VERSION = "2023-01-01-preview";
const DOCS = "https://raw.githubusercontent.com/hashicorp/terraform-provider-azurerm";

/** `~> 4.81` -> `v4.81.0`: the docs at the first release of the pinned minor. */
const docsTag = `v${/\d+\.\d+/.exec(PROVIDER_VERSIONS.azure.version)?.[0]}.0`;

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: returned ${response.status}`);
  return response.text();
}

const docPages = new Map();
async function docPage(name) {
  if (!docPages.has(name)) docPages.set(name, await getText(`${DOCS}/${docsTag}/website/docs/r/${name}.html.markdown`));
  return docPages.get(name);
}

/** Every row a price-list filter returns, following the pages. */
async function priceRows(filter) {
  const rows = [];
  let url = `${PRICES}?api-version=${PRICES_VERSION}&$filter=${encodeURIComponent(`priceType eq 'Consumption' and ${filter}`)}`;
  for (let page = 0; url && page < 80; page++) {
    const body = JSON.parse(await getText(url));
    rows.push(...(body.Items ?? []));
    url = body.NextPageLink ?? null;
  }
  return rows;
}

/** Documented values, failing loudly when a page stops listing any: the docs changed shape. */
async function listed(page, attribute) {
  const values = docValues(await docPage(page), attribute);
  if (values.length === 0) throw new Error(`azurerm docs ${page}: no values found for \`${attribute}\``);
  return values;
}

const DATABASE_SKU = "^(?:B|GP|MO)_Standard_[A-Za-z0-9_]+$";

/** One entry per rule id in azure-sku.ts. */
const RULES = {
  "app-service-plan": {
    valid: () => listed("service_plan", "sku_name"),
    prices: async () => [
      ...regionsBySku(await priceRows("serviceName eq 'Azure App Service'"), (r) => appServiceSku(r.skuName)),
      ...regionsBySku(
        await priceRows("serviceName eq 'Functions' and productName eq 'Flex Consumption'"),
        () => "FC1",
      ),
    ],
  },
  "redis-cache": {
    valid: () => listed("redis_cache", "sku_name"),
    prices: async () =>
      regionsBySku(await priceRows("serviceName eq 'Redis Cache' and contains(productName, 'Azure Redis Cache')"), (r) => {
        const tier = /^Azure Redis Cache (Basic|Standard|Premium)$/.exec(r.productName);
        return tier ? tier[1] : null;
      }),
  },
  "storage-account": {
    valid: async () =>
      storageSkus(await listed("storage_account", "account_tier"), await listed("storage_account", "account_replication_type")),
    prices: async () =>
      regionsBySku(
        await priceRows("serviceName eq 'Storage' and productName eq 'General Block Blob v2' and startswith(skuName, 'Hot ')"),
        (r) => storageSkuFromPrice(r.skuName),
      ),
  },
  "postgres-flexible": {
    pattern: DATABASE_SKU,
    docsMention: ["postgresql_flexible_server", "GP_Standard_D2s_v3"],
    prices: async () =>
      regionsBySku(
        await priceRows(
          "serviceName eq 'Azure Database for PostgreSQL' and productName eq 'Azure Database for PostgreSQL Flexible Server General Purpose Dsv3 Series Compute'",
        ),
        () => "GP_Standard_D2s_v3",
      ),
  },
  "mysql-flexible": {
    pattern: DATABASE_SKU,
    docsMention: ["mysql_flexible_server", "GP_Standard_D2ds_v4"],
    prices: async () =>
      regionsBySku(
        await priceRows(
          "serviceName eq 'Azure Database for MySQL' and armSkuName eq 'AzureDB_MySQL_Flexible_Server_General_Purpose_Ddsv4_Compute'",
        ),
        () => "GP_Standard_D2ds_v4",
      ),
  },
  "key-vault": { valid: () => listed("key_vault", "sku_name") },
  "load-balancer": { valid: () => listed("lb", "sku") },
  "service-bus": { valid: () => listed("servicebus_namespace", "sku") },
  "front-door": { valid: () => listed("cdn_frontdoor_profile", "sku_name") },
  "log-analytics": { valid: () => listed("log_analytics_workspace", "sku") },
};

const rules = {};
const priced = {};
const allRegions = new Set();
for (const [id, rule] of Object.entries(RULES)) {
  const entry = {};
  if (rule.pattern) {
    const [page, example] = rule.docsMention;
    if (!(await docPage(page)).includes(example)) throw new Error(`azurerm docs ${page}: no longer mention ${example}`);
    entry.valid = [];
    entry.pattern = rule.pattern;
  } else {
    entry.valid = await rule.valid();
  }
  if (rule.prices) {
    const bySku = new Map(await rule.prices());
    if (bySku.size === 0) throw new Error(`${id}: the price list returned no regions`);
    for (const regions of bySku.values()) for (const r of regions) allRegions.add(r);
    priced[id] = bySku;
  }
  rules[id] = entry;
  console.log(`${id}: ${entry.valid.length} values${priced[id] ? `, ${priced[id].size} with regions` : ""}`);
}

// A region only ever seen through a price row of one rule is still a region.
const regions = [...allRegions].map(regionKey).sort();
for (const [id, bySku] of Object.entries(priced)) rules[id].available = packAvailability(bySku, regions);

const today = new Date().toISOString().slice(0, 10);
const data = (date) => ({
  refreshed: date,
  sources: {
    docs: `hashicorp/terraform-provider-azurerm ${docsTag} website/docs/r`,
    prices: `${PRICES} (api-version ${PRICES_VERSION})`,
  },
  regions,
  rules,
});

const target = fileURLToPath(new URL("../packages/engine/src/azure-sku-data.ts", import.meta.url));
const before = await readFile(target, "utf8").catch(() => "");
const recorded = /refreshed: "(\d{4}-\d{2}-\d{2})"/.exec(before)?.[1] ?? today;
if (renderSkuDataFile(data(recorded)) === before) {
  console.log(`unchanged ${target}`);
} else {
  await writeFile(target, renderSkuDataFile(data(today)), "utf8");
  console.log(`wrote ${target}`);
}
