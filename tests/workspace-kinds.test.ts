// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addNode } from "terragram-engine/inspector";
import {
  cloudSpec,
  KIND_DEFINITIONS,
  MODEL_KIND_IDS,
  resourceTypeToKind,
} from "terragram-engine/kinds";
import { type Cloud, EMPTY_MODEL, GENERATED_CLOUDS, type InfraModel } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";
import { emitTerraform } from "terragram-engine/terraform";

/**
 * The invariant the registry exists to enforce. Before it, adding a kind meant
 * editing four tables nothing forced to agree; these table-driven checks are what
 * replaces that hope with a failing test.
 */

const REAL = KIND_DEFINITIONS.filter((d) => d.role !== "conceptual" && d.role !== "external");
/** The kinds Terragram builds: those with a spec on a cloud it generates for. Google Cloud's own kinds are only read. */
const EMITTABLE = REAL.filter((d) => d.azure !== null || d.aws !== null);

/** A one-node model for a kind, so each kind is exercised on its own. */
function modelFor(kind: string): InfraModel {
  const added = addNode(EMPTY_MODEL, kind);
  assert.ok(added, `${kind} should be addable`);
  return added.model;
}

describe("kind registry", () => {
  it("offers every non-conceptual kind to a translator", () => {
    assert.deepEqual([...MODEL_KIND_IDS].sort(), EMITTABLE.map((d) => d.kind).sort());
    assert.equal(MODEL_KIND_IDS.includes("internet"), false);
    assert.equal(MODEL_KIND_IDS.includes("external"), false);
  });

  it("gives every kind both clouds", () => {
    for (const definition of EMITTABLE) {
      assert.ok(definition.azure, `${definition.kind} is missing an Azure spec`);
      assert.ok(definition.aws, `${definition.kind} is missing an AWS spec`);
    }
  });

  it("gives every kind that is only read a Google Cloud spec, and no emit", () => {
    for (const definition of REAL.filter((d) => !EMITTABLE.includes(d))) {
      assert.ok(definition.gcp, `${definition.kind} has no spec on any cloud`);
      assert.equal("emit" in definition.gcp, false);
      assert.equal(MODEL_KIND_IDS.includes(definition.kind), false);
    }
  });

  for (const cloud of GENERATED_CLOUDS) {
    for (const definition of EMITTABLE) {
      it(`emits valid-shaped ${cloud} HCL for ${definition.kind}`, () => {
        const out = emitTerraform(modelFor(definition.kind), cloud as Cloud);
        const main = out.files[0]?.content ?? "";
        const spec = cloudSpec(definition.kind, cloud as Cloud);
        assert.ok(spec);
        // A kind emits either its primary resource or a pinned registry module — and
        // the module it names must be the one the pin file records.
        const expected = spec?.moduleSource
          ? `source  = "${spec.moduleSource}"`
          : `resource "${spec?.type}"`;
        assert.ok(
          main.replace(/\s+=\s+/g, " = ").includes(expected.replace(/\s+=\s+/g, " = ")),
          `${definition.kind}/${cloud} did not emit ${expected}`,
        );
        if (spec?.moduleSource) {
          assert.ok(
            out.modules.some((m) => m.source === spec.moduleSource && /^\d+\.\d+\.\d+$/.test(m.version)),
            `${definition.kind}/${cloud} module call is not pinned to an exact version`,
          );
        }
        // Balanced braces is a cheap proxy for "this is a document, not a fragment".
        const opens = (main.match(/\{/g) ?? []).length;
        const closes = (main.match(/\}/g) ?? []).length;
        assert.equal(opens, closes, `${definition.kind}/${cloud} has unbalanced braces`);
      });

      it(`round-trips ${definition.kind} through the ${cloud} reverse map`, () => {
        const spec = cloudSpec(definition.kind, cloud as Cloud);
        assert.ok(spec);
        const out = emitTerraform(modelFor(definition.kind), cloud as Cloud);
        const parsed = parseTerraform(out.files[0]?.content ?? "");
        assert.equal(parsed.ok, true, `${definition.kind}/${cloud} did not parse back`);
        if (!parsed.ok) return;
        assert.ok(
          parsed.model.nodes.some((n) => n.kind === definition.kind),
          `${definition.kind}/${cloud} came back as ${parsed.model.nodes.map((n) => n.kind).join(", ")}`,
        );
      });
    }
  }

  it("disambiguates a resource type two kinds share", () => {
    // aws_db_instance is postgres or mysql depending on its engine — the only thing
    // that tells them apart is an attribute, so the reverse map has to read one.
    const pg = emitTerraform(modelFor("postgres"), "aws").files[0]?.content ?? "";
    const my = emitTerraform(modelFor("mysql"), "aws").files[0]?.content ?? "";
    const parsedPg = parseTerraform(pg);
    const parsedMy = parseTerraform(my);
    assert.equal(parsedPg.ok && parsedMy.ok, true);
    if (!parsedPg.ok || !parsedMy.ok) return;
    assert.ok(parsedPg.model.nodes.some((n) => n.kind === "postgres"));
    assert.ok(parsedMy.model.nodes.some((n) => n.kind === "mysql"));
  });

  it("maps a resource type to a kind without needing the block", () => {
    assert.equal(resourceTypeToKind("azurerm_redis_cache", "azure")?.kind, "redis-cache");
    assert.equal(resourceTypeToKind("aws_sqs_queue", "aws")?.kind, "queue");
    assert.equal(resourceTypeToKind("google_storage_bucket", "aws"), null);
  });
});
