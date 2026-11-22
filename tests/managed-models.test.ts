// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resolvedModel } from "../src/features/workspace/inference.ts";
import {
  DEFAULT_MANAGED_MODEL,
  isManagedModelId,
  MANAGED_MODEL_IDS,
  MANAGED_MODELS,
  migrateManagedModelId,
} from "../src/features/workspace/managed-models.ts";
import { parseSettings, workspaceSettingsSchema } from "../src/features/workspace/settings.ts";

const ENV_KEY = "TERRAGRAM_WORKSPACE_MODEL";

describe("managed model allow-list", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("offers only models the EU proxy can serve", () => {
    // Every id here must have an `eu.` Bedrock inference profile. Fable and Haiku
    // do not, and the failure is silent: the proxy answers with its default under
    // the name that was asked for. If this assertion is ever loosened, check the
    // AWS model card AND the proxy's map before doing it.
    assert.deepEqual([...MANAGED_MODEL_IDS], ["claude-sonnet-5-5", "claude-opus-5-5"]);
    for (const id of ["claude-fable-5-1", "claude-fable-5", "claude-haiku-4-5"]) {
      assert.equal(isManagedModelId(id), false, `${id} has no eu. profile and must not be offered`);
    }
  });

  it("describes every offered model exactly once", () => {
    assert.deepEqual(
      MANAGED_MODELS.map((m) => m.id),
      [...MANAGED_MODEL_IDS],
    );
    for (const m of MANAGED_MODELS) {
      assert.ok(m.label.length > 0 && m.note.length > 0, `${m.id} needs a label and a note`);
    }
  });

  it("refuses anything that is not an offered id", () => {
    assert.equal(isManagedModelId("claude-sonnet-5-5"), true);
    // The 5 ids are no longer offered; they are migrated, never accepted as they are.
    assert.equal(isManagedModelId("claude-sonnet-5"), false);
    assert.equal(isManagedModelId("claude-opus-5"), false);
    assert.equal(isManagedModelId("us.anthropic.claude-sonnet-5-5"), false);
    assert.equal(isManagedModelId(""), false);
    assert.equal(isManagedModelId(null), false);
    assert.equal(isManagedModelId(undefined), false);
    assert.equal(isManagedModelId({ id: "claude-opus-5-5" }), false);
  });
});

describe("retired model ids", () => {
  it("move to the 5.5 model of the same tier", () => {
    assert.equal(migrateManagedModelId("claude-sonnet-5"), "claude-sonnet-5-5");
    assert.equal(migrateManagedModelId("claude-opus-5"), "claude-opus-5-5");
  });

  it("leave every other value alone, including inherited object keys", () => {
    assert.equal(migrateManagedModelId("claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(migrateManagedModelId("us.anthropic.claude-opus-5"), "us.anthropic.claude-opus-5");
    assert.equal(migrateManagedModelId("constructor"), "constructor");
    assert.equal(migrateManagedModelId(undefined), undefined);
  });
});

describe("resolvedModel", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("takes the caller's choice when it is one we serve", () => {
    assert.equal(resolvedModel("claude-opus-5-5"), "claude-opus-5-5");
  });

  it("never forwards an id the proxy would treat as a raw Bedrock id", () => {
    // The proxy passes any requested id containing a `.` straight through, so this
    // is the gate that keeps a US-region profile from moving UK inference abroad.
    assert.equal(resolvedModel("us.anthropic.claude-opus-5-5"), DEFAULT_MANAGED_MODEL);
    assert.equal(resolvedModel("../../etc/passwd"), DEFAULT_MANAGED_MODEL);
  });

  it("falls back to this deployment's configured default", () => {
    process.env[ENV_KEY] = "claude-opus-5-5";
    assert.equal(resolvedModel(), "claude-opus-5-5");
    assert.equal(resolvedModel("not-a-model"), "claude-opus-5-5");
  });

  it("migrates a retired id from the caller or the deployment", () => {
    assert.equal(resolvedModel("claude-opus-5"), "claude-opus-5-5");
    process.env[ENV_KEY] = "claude-sonnet-5";
    assert.equal(resolvedModel(), "claude-sonnet-5-5");
  });

  it("ignores a configured default we cannot serve rather than forwarding it", () => {
    // A deployment typo degrades to Sonnet instead of failing every managed turn.
    process.env[ENV_KEY] = "claude-fable-5-1";
    assert.equal(resolvedModel(), DEFAULT_MANAGED_MODEL);
  });

  it("falls back to Sonnet with nothing configured", () => {
    assert.equal(resolvedModel(), DEFAULT_MANAGED_MODEL);
    assert.equal(DEFAULT_MANAGED_MODEL, "claude-sonnet-5-5");
  });
});

describe("the model setting", () => {
  it("migrates a stored retired id without resetting the other preferences", () => {
    const stored = { inferenceModel: "claude-opus-5", autoLayout: false, labelFace: "sans" };
    assert.equal(workspaceSettingsSchema.parse(stored).inferenceModel, "claude-opus-5-5");
    const settings = parseSettings(stored);
    assert.equal(settings.inferenceModel, "claude-opus-5-5");
    assert.equal(settings.autoLayout, false);
    assert.equal(settings.labelFace, "sans");
  });

  it("defaults to Sonnet", () => {
    assert.equal(workspaceSettingsSchema.parse({}).inferenceModel, DEFAULT_MANAGED_MODEL);
  });

  it("accepts an offered model and rejects anything else", () => {
    assert.equal(
      workspaceSettingsSchema.parse({ inferenceModel: "claude-opus-5-5" }).inferenceModel,
      "claude-opus-5-5",
    );
    assert.equal(
      workspaceSettingsSchema.safeParse({ inferenceModel: "us.anthropic.claude-opus-5-5" }).success,
      false,
    );
  });
});
