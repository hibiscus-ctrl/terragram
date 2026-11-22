// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Managed-model map contract (contracts/model-map.json).
 *
 * Terragram decides which models a managed turn may ask for
 * (`MANAGED_MODEL_IDS`); the EU gateway decides which Bedrock id each one runs as
 * (its `bedrock_model_map`). A model asked for with no key over there is answered
 * by the gateway's DEFAULT model under the name the caller asked for, and metered
 * at the default's rate — silently. Nothing spans the two repos, so this fixture
 * does: a byte-for-byte copy of the gateway's own, re-checked against the sibling
 * checkout when it is present.
 *
 * Terragram sends the BARE id (`claude-sonnet-5-5`); the gateway resolves a bare
 * name through its `anthropic/` key, so that is the mapping asserted here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isManagedModelId, MANAGED_MODEL_IDS } from "../src/features/workspace/managed-models.ts";

const here = dirname(fileURLToPath(import.meta.url));
const own = readFileSync(join(here, "..", "contracts", "model-map.json"), "utf8");
const contract = JSON.parse(own) as {
  models: Record<string, { cloud_slug: string; bedrock_id: string }>;
  unservable: string[];
};

const proxyDir = join(here, "..", "..", "infraweaver-proxy");
const bare = (specifier: string) => specifier.slice(specifier.indexOf("/") + 1);

describe("model-map contract", () => {
  it("offers only models the gateway maps", () => {
    for (const id of MANAGED_MODEL_IDS) {
      assert.ok(`anthropic/${id}` in contract.models, `${id} is offered but the gateway has no key for it`);
    }
  });

  it("refuses every Claude model the gateway deliberately does not map", () => {
    for (const specifier of contract.unservable) {
      assert.equal(isManagedModelId(bare(specifier)), false, bare(specifier));
      assert.equal(isManagedModelId(specifier), false, specifier);
    }
  });

  it("resolves every offered id to its pinned Bedrock id under the gateway's resolver", async (t) => {
    const resolver = join(proxyDir, "src", "bedrock.ts");
    if (!existsSync(resolver)) return t.skip("../infraweaver-proxy not checked out");
    const { resolveBedrockModel } = (await import(pathToFileURL(resolver).href)) as {
      resolveBedrockModel: (
        requested: string,
        config: { modelMap: Record<string, string>; defaultModelId: string },
      ) => string;
    };
    const modelMap = Object.fromEntries(
      Object.entries(contract.models).map(([k, v]) => [k, v.bedrock_id]),
    );
    for (const id of MANAGED_MODEL_IDS) {
      assert.equal(
        resolveBedrockModel(id, { modelMap, defaultModelId: "the-default" }),
        contract.models[`anthropic/${id}`]?.bedrock_id,
        `${id} would be served as the gateway's default`,
      );
    }
  });

  it("matches the sibling repo's copy byte-for-byte", (t) => {
    let sibling: string;
    try {
      sibling = readFileSync(join(proxyDir, "contracts", "model-map.json"), "utf8");
    } catch {
      return t.skip("../infraweaver-proxy not checked out");
    }
    assert.equal(sibling, own);
  });
});
