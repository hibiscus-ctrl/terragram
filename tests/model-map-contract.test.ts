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
 * does: a copy of the gateway's own map, kept by hand (see AGENTS.md). These tests check
 * Terragram's side of it.
 *
 * Terragram sends the BARE id (`claude-sonnet-5-5`); the gateway resolves a bare
 * name through its `anthropic/` key, so that is the mapping asserted here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isManagedModelId, MANAGED_MODEL_IDS } from "terragram-engine/managed-models";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(here, "..", "contracts", "model-map.json"), "utf8")) as {
  models: Record<string, { cloud_slug: string; bedrock_id: string }>;
  unservable: string[];
};

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
});
