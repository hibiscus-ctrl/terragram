// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The SKU data refresh's pure parts: reading the provider docs, reading price rows,
 * and the file it writes. The script itself needs the network; these do not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AZURE_SKU_DATA } from "terragram-engine/azure-sku-data";

// Plain .mjs ops script helpers, deliberately untyped like their peers in scripts/.
import {
  appServiceSku,
  docValues,
  packAvailability,
  regionKey,
  regionsBySku,
  renderSkuDataFile,
  storageSkuFromPrice,
  storageSkus,
} from "../scripts/lib/azure-skus.mjs";

describe("docValues", () => {
  const page = [
    "* `name` - (Required) The name.",
    "* `sku_name` - (Required) The SKU. Possible values include `B1`, `P1v3`, and `Y1`. Not `bad value` or `x;y`.",
    "* `os_type` - (Required) `Linux`.",
  ].join("\n");

  it("takes the back-ticked words on that argument's line, not its name", () => {
    assert.deepEqual(docValues(page, "sku_name"), ["B1", "P1v3", "Y1"]);
  });

  it("finds nothing for an argument the page does not list", () => {
    assert.deepEqual(docValues(page, "tier"), []);
  });
});

describe("price rows", () => {
  it("names an App Service plan SKU the way azurerm does", () => {
    assert.equal(appServiceSku("P1 v3"), "P1v3");
    assert.equal(appServiceSku("I1mv2"), "I1mv2");
    assert.equal(appServiceSku("B1"), "B1");
    assert.equal(appServiceSku("Stamp"), null);
    assert.equal(appServiceSku("ASIP"), null);
  });

  it("names a storage redundancy from a hot-tier price", () => {
    assert.equal(storageSkuFromPrice("Hot RA-GZRS"), "Standard_RAGZRS");
    assert.equal(storageSkuFromPrice("Cool LRS"), null);
  });

  it("builds Standard and Premium storage SKUs, Premium only with LRS and ZRS", () => {
    assert.deepEqual(storageSkus(["Standard", "Premium", "BlockBlobStorage"], ["LRS", "GRS", "ZRS"]), [
      "Standard_LRS",
      "Standard_GRS",
      "Standard_ZRS",
      "Premium_LRS",
      "Premium_ZRS",
    ]);
  });

  it("collects the ordinary regions that price a SKU, sorted, ignoring global and zone rows", () => {
    const rows = [
      { skuName: "B1", armRegionName: "westeurope" },
      { skuName: "B1", armRegionName: "uksouth" },
      { skuName: "B1", armRegionName: "uksouth" },
      { skuName: "B1", armRegionName: "Global" },
      { skuName: "B1", armRegionName: "Zone 1" },
      { skuName: "B1", armRegionName: "" },
      { skuName: "Stamp", armRegionName: "uksouth" },
    ];
    const bySku = regionsBySku(rows, (r: { skuName: string }) => appServiceSku(r.skuName));
    assert.deepEqual([...bySku], [["B1", ["uksouth", "westeurope"]]]);
  });

  it("writes a region as Terraform does", () => {
    assert.equal(regionKey("UK South"), "uksouth");
  });
});

describe("packAvailability", () => {
  it("stores the regions that do not sell a SKU, once per distinct list", () => {
    const all = ["a", "b", "c", "d"];
    const bySku = new Map([
      ["X", ["a", "b", "c", "d"]],
      ["Y", ["a", "b"]],
      ["Z", ["a", "b"]],
    ]);
    assert.deepEqual(packAvailability(bySku, all), { sets: [[], ["c", "d"]], skus: { X: 0, Y: 1, Z: 1 } });
  });

  it("orders SKUs by name so the file does not depend on the order rows arrived in", () => {
    const all = ["a", "b"];
    const forward = packAvailability(new Map([["A", ["a"]], ["B", ["b"]]]), all);
    const reverse = packAvailability(new Map([["B", ["b"]], ["A", ["a"]]]), all);
    assert.deepEqual(forward, reverse);
  });
});

describe("renderSkuDataFile", () => {
  it("writes a source file with the licence header that reads back as the same data", async () => {
    const text = renderSkuDataFile(AZURE_SKU_DATA);
    assert.ok(text.startsWith("// Copyright 2026 Gabriel Ignat\n// SPDX-License-Identifier: AGPL-3.0-only\n"));
    assert.ok(text.includes(`"refreshed": "${AZURE_SKU_DATA.refreshed}"`));
    const body = text.slice(text.indexOf("export const AZURE_SKU_DATA: AzureSkuData = ") + "export const AZURE_SKU_DATA: AzureSkuData = ".length).replace(/;\n$/, "");
    assert.deepEqual(JSON.parse(body), JSON.parse(JSON.stringify(AZURE_SKU_DATA)));
  });

  it("is what the checked-in file says, so the refresh leaves a clean tree when nothing changed", async () => {
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(new URL("../packages/engine/src/azure-sku-data.ts", import.meta.url), "utf8");
    assert.equal(renderSkuDataFile(AZURE_SKU_DATA), onDisk);
  });
});
