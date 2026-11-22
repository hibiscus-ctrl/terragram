// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type InterchangeResult,
  looksLikeMermaid,
  parseMermaid,
} from "../src/features/workspace/interchange.ts";
import { SAMPLE_MERMAID } from "../src/features/workspace/samples.ts";
import { emitTerraform } from "../src/features/workspace/terraform.ts";

/**
 * The importer's promise: what you drew is what you get. Every box lands on the
 * diagram — as a component when its label matches one, flagged when it does not —
 * and every arrow survives as a connection the reviewer owns.
 */

function ok(source: string): Extract<InterchangeResult, { ok: true }> {
  const res = parseMermaid(source);
  if (!res.ok) assert.fail(res.error);
  return res;
}

describe("looksLikeMermaid", () => {
  it("recognises a flowchart or graph header, ignoring leading comments", () => {
    assert.equal(looksLikeMermaid("flowchart LR\n a --> b"), true);
    assert.equal(looksLikeMermaid("%% note\n\ngraph TD\n a --> b"), true);
    assert.equal(looksLikeMermaid('resource "aws_s3_bucket" "x" {}'), false);
    assert.equal(looksLikeMermaid("a web app with a database"), false);
  });
});

describe("parseMermaid", () => {
  it("maps labels to kinds and keeps the arrows as the reviewer's own topology", () => {
    const { model } = ok(`flowchart LR
  users((Users)) --> web[Web app]
  web --> db[(Postgres database)]
  web --> cache[Redis cache]
`);
    const kinds = model.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["app-service", "internet", "postgres", "redis-cache"]);
    assert.equal(model.topology, "manual");

    const own = model.edges.filter((e) => e.origin === "user").map((e) => e.id).sort();
    assert.deepEqual(own, ["app-service->postgres", "app-service->redis-cache"]);
    // The Users box is the conceptual internet node, not a resource.
    assert.ok(model.edges.some((e) => e.source === "internet" && e.target === "app-service"));
  });

  it("keeps a box it cannot match, flagged, rather than dropping it", () => {
    const { model, untranslated } = ok(`flowchart TD
  web[Web app] --> crm[Legacy CRM]
`);
    assert.deepEqual(untranslated, ["Legacy CRM"]);
    const crm = model.nodes.find((n) => n.kind === "external");
    assert.ok(crm, "the unmatched box must stay on the diagram");
    assert.equal(crm?.label, "Legacy CRM");
    assert.match(crm?.flag?.reason ?? "", /does not match/);
    assert.ok(model.edges.some((e) => e.target === crm?.id && e.origin === "user"));
  });

  it("reads every node shape and both arrow-label syntaxes", () => {
    const { model } = ok(`graph LR
  a[Web app] -->|https| b(Redis cache)
  b -- writes --> c((Postgres))
  c ==> d{Key vault}
  d -.-> e[[Monitoring]]
  e --- f[(Message queue)]
  f --> g>Load balancer]
  g --> h{{Object storage}}
`);
    const kinds = model.nodes.filter((n) => n.kind !== "internet").map((n) => n.kind);
    assert.deepEqual(kinds, [
      "app-service",
      "redis-cache",
      "postgres",
      "key-vault",
      "monitoring",
      "queue",
      "load-balancer",
      "object-storage",
    ]);
    assert.equal(model.edges.filter((e) => e.origin === "user").length, 7);
  });

  it("expands chains and & groups into one edge per pair", () => {
    const { model } = ok(`flowchart LR
  lb[Load balancer] --> web[Web app] --> db[(Postgres)]
  web --> cache[Redis] & queue[Queue]
`);
    const ids = model.edges.filter((e) => e.origin === "user").map((e) => e.id).sort();
    assert.deepEqual(ids, [
      "app-service->postgres",
      "app-service->queue",
      "app-service->redis-cache",
      "load-balancer->app-service",
    ]);
  });

  it("skips styling, classes, comments and subgraph boundaries but reads their members", () => {
    const { model } = ok(`flowchart TB
  %% a comment line
  classDef store fill:#eee
  subgraph data [Data tier]
    direction LR
    db[(Postgres)]:::store
  end
  web[Web app] --> db
  style web fill:#fff
  click web "https://example.test"
`);
    const kinds = model.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["app-service", "internet", "postgres"]);
    assert.ok(model.nodes.every((n) => n.id !== "data"), "the subgraph id is not a node");
  });

  it("strips quotes and <br> from labels and reads quoted labels with special characters", () => {
    const { model } = ok(`flowchart LR
  a["Web app<br/>(public)"] --> b["Postgres database"]
`);
    assert.equal(model.nodes.find((n) => n.kind === "app-service")?.label, "Web app (public)");
    assert.equal(model.nodes.find((n) => n.kind === "postgres")?.label, "Postgres database");
  });

  it("gives two boxes of the same kind distinct ids", () => {
    const { model } = ok(`flowchart LR
  web[Web app] --> a[(Postgres primary)]
  web --> b[(Postgres replica)]
`);
    const ids = model.nodes.filter((n) => n.kind === "postgres").map((n) => n.id).sort();
    assert.deepEqual(ids, ["postgres", "postgres-2"]);
  });

  it("adds the internet node when the chart has no outside-world box", () => {
    const { model } = ok(`flowchart LR
  web[Web app] --> db[(Postgres)]
`);
    assert.ok(model.edges.some((e) => e.id === "internet->app-service" && e.origin === "derived"));
  });

  it("refuses Terraform and prose with an error that names the expected format", () => {
    const tf = parseMermaid('resource "aws_s3_bucket" "x" {}');
    assert.equal(tf.ok, false);
    assert.match(tf.ok ? "" : tf.error, /flowchart/);
    const empty = parseMermaid("flowchart LR\n");
    assert.equal(empty.ok, false);
  });

  it("imports the shipped sample into a model the emitter can generate from", () => {
    const { model, untranslated } = ok(SAMPLE_MERMAID);
    assert.deepEqual(untranslated, ["Legacy CRM"]);
    const kinds = new Set(model.nodes.map((n) => n.kind));
    for (const kind of ["front-door", "app-service", "postgres", "redis-cache", "queue", "functions", "monitoring"]) {
      assert.ok(kinds.has(kind), `${kind} should be read from the sample`);
    }
    const out = emitTerraform(model, "azure", "terraform");
    assert.ok(out.files.some((f) => f.name === "main.tf" && f.content.includes("azurerm_")));
  });
});
