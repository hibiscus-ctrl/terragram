// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleModel, composeFromPrompt } from "terragram-engine/engine";
import { explainModel } from "terragram-engine/explain";
import { addNode, removeNodes, setNodeAttribute } from "terragram-engine/inspector";
import { EMPTY_MODEL } from "terragram-engine/model";
import { templateModel, WORKSPACE_TEMPLATES } from "terragram-engine/templates";

const WEB_PROMPT = "A web app with a Postgres database and Redis cache";

describe("explainModel", () => {
  it("describes the request path in plain English", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const text = explainModel(model, "azure", "UK South");
    assert.match(text, /targets Azure in UK South/);
    assert.match(text, /Requests arrive from the public internet/);
    assert.match(text, /Front Door/);
  });

  it("names what still needs confirming, rather than glossing over it", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const text = explainModel(model, "azure", "UK South");
    assert.match(text, /Needs confirming/);
    assert.match(text, /PostgreSQL/);
  });

  it("says so when nothing is unconfirmed", () => {
    const added = addNode(EMPTY_MODEL, "object-storage");
    assert.ok(added);
    const text = explainModel(added!.model, "aws", "London (eu-west-2)");
    assert.match(text, /Nothing is left unconfirmed/);
  });

  it("mentions a reviewer's chosen attribute", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const chosen = setNodeAttribute(model, "postgres", "PostgreSQL version", "PostgreSQL 17");
    assert.match(explainModel(chosen, "azure", "UK South"), /PostgreSQL 17/);
  });

  it("is deterministic and needs no key or network", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    assert.equal(
      explainModel(model, "azure", "UK South"),
      explainModel(model, "azure", "UK South"),
    );
  });

  it("handles an empty model without pretending there is one", () => {
    assert.match(explainModel(EMPTY_MODEL, "azure", "UK South"), /no infrastructure yet/);
  });
});

describe("structural edits", () => {
  it("marks the topology manual so a later turn cannot re-derive it", () => {
    const added = addNode(EMPTY_MODEL, "queue");
    assert.ok(added);
    assert.equal(added!.model.topology, "manual");
  });

  it("keeps a hand-drawn edge when a chat turn adds a node", () => {
    const a = addNode(EMPTY_MODEL, "app-service");
    assert.ok(a);
    const b = addNode(a!.model, "postgres");
    assert.ok(b);
    const manual = { ...b!.model, edges: [
      { id: "e1", source: a!.id, target: b!.id, origin: "user" as const },
    ] };

    const next = assembleModel(["redis-cache"], manual).model;
    assert.ok(
      next.edges.some((e) => e.source === a!.id && e.target === b!.id && e.origin === "user"),
      "the hand-drawn edge should survive a chat turn",
    );
    assert.ok(next.nodes.some((n) => n.kind === "redis-cache"));
  });

  it("drops the edges of a removed node", () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const pruned = removeNodes(model, ["postgres"]);
    assert.equal(pruned.nodes.some((n) => n.id === "postgres"), false);
    assert.equal(
      pruned.edges.some((e) => e.source === "postgres" || e.target === "postgres"),
      false,
    );
  });
});

describe("templates", () => {
  for (const template of WORKSPACE_TEMPLATES) {
    it(`instantiates "${template.name}" into a connected model`, () => {
      const model = templateModel(template);
      assert.ok(model.nodes.length >= template.kinds.length);
      for (const kind of template.kinds) {
        assert.ok(model.nodes.some((n) => n.kind === kind), `${kind} missing`);
      }
      // Every node except the conceptual ingress should be reachable.
      const connected = new Set(model.edges.flatMap((e) => [e.source, e.target]));
      for (const node of model.nodes) {
        assert.ok(connected.has(node.id), `${node.id} is floating`);
      }
    });
  }
});
