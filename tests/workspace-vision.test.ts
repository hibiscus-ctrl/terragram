// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGraphModel } from "terragram-engine/graph-build";
import { DEFAULT_MANAGED_MODEL } from "terragram-engine/managed-models";
import type { MessagesRequest, ModelClient } from "terragram-engine/ports";
import { buildImageRequest, modelFromReading, runManagedDiagramRead } from "terragram-engine/vision";

const IMAGE = { data: "aGVsbG8=", mediaType: "image/png" as const };

describe("diagram picture request", () => {
  it("sends the image as a base64 block and forces the emit_diagram tool", () => {
    const req = buildImageRequest("claude-sonnet-5-5", IMAGE) as {
      messages: Array<{ content: Array<{ type: string; source?: { media_type: string; data: string } }> }>;
      tool_choice: { name: string };
      tools: Array<{ input_schema: { properties: { components: { items: { properties: { kind: { enum: unknown[] } } } } } } }>;
    };
    const image = req.messages[0]?.content.find((c) => c.type === "image");
    assert.equal(image?.source?.media_type, "image/png");
    assert.equal(image?.source?.data, "aGVsbG8=");
    assert.equal(req.tool_choice.name, "emit_diagram");
    const kinds = req.tools[0]?.input_schema.properties.components.items.properties.kind.enum ?? [];
    assert.ok(kinds.includes("postgres"));
    assert.ok(kinds.includes("internet"), "the outside-world box must be nameable");
    assert.ok(kinds.includes(null), "a box that is not a cloud component must be nameable as null");
  });
});

describe("modelFromReading", () => {
  it("turns boxes and arrows into a manual-topology model with the arrows as the reviewer's edges", () => {
    const result = modelFromReading({
      reply: "A web tier with a database.",
      components: [
        { ref: "a1", label: "Users", kind: "internet" },
        { ref: "a2", label: "Web App", kind: "app-service" },
        { ref: "a3", label: "Orders DB", kind: "postgres" },
      ],
      connections: [
        { from: "a1", to: "a2" },
        { from: "a2", to: "a3" },
      ],
    });
    assert.ok(result);
    assert.equal(result?.model.topology, "manual");
    assert.deepEqual(result?.model.nodes.map((n) => n.kind), ["internet", "app-service", "postgres"]);
    assert.deepEqual(
      result?.model.edges.map((e) => [e.id, e.origin]),
      [
        ["internet->app-service", "derived"],
        ["app-service->postgres", "user"],
      ],
    );
    assert.equal(result?.model.nodes.find((n) => n.kind === "postgres")?.label, "Orders DB");
  });

  it("keeps a box the model could not name, flagged, and label-matches an invented kind", () => {
    const result = modelFromReading({
      components: [
        { ref: "a1", label: "Web App", kind: "app-service" },
        { ref: "a2", label: "Legacy CRM", kind: null },
        { ref: "a3", label: "Redis cache", kind: "not-a-kind" },
      ],
      connections: [{ from: "a1", to: "a2" }],
    });
    assert.deepEqual(result?.untranslated, ["Legacy CRM"]);
    const crm = result?.model.nodes.find((n) => n.kind === "external");
    assert.equal(crm?.label, "Legacy CRM");
    assert.ok(result?.model.edges.some((e) => e.target === crm?.id && e.origin === "user"));
    // An out-of-vocabulary kind is not trusted; the label decides instead.
    assert.ok(result?.model.nodes.some((n) => n.kind === "redis-cache"));
  });

  it("raises the model's own uncertainty as a review flag and drops dangling arrows", () => {
    const result = modelFromReading({
      components: [{ ref: "a1", label: "Queue?", kind: "queue", flag_reason: "Label partly illegible." }],
      connections: [{ from: "a1", to: "zz" }],
    });
    assert.equal(result?.model.nodes.find((n) => n.kind === "queue")?.flag?.reason, "Label partly illegible.");
    assert.equal(result?.model.edges.filter((e) => e.origin === "user").length, 0);
  });

  it("returns null for an unusable reading", () => {
    assert.equal(modelFromReading({ components: "nope" }), null);
  });
});

describe("runManagedDiagramRead", () => {
  const reading = {
    reply: "ok",
    components: [{ ref: "a1", label: "Postgres", kind: "postgres" }],
    connections: [],
  };

  it("sends the image through the model client and reads the tool call back", async () => {
    const seen: MessagesRequest[] = [];
    const client: ModelClient = {
      async toolCall(request) {
        seen.push(request);
        return reading;
      },
    };

    const result = await runManagedDiagramRead({ client, image: IMAGE, model: DEFAULT_MANAGED_MODEL });
    assert.ok(result.model.nodes.some((n) => n.kind === "postgres"));
    const body = seen[0] as { model: string; messages: Array<{ content: Array<{ type: string }> }> };
    assert.equal(body.model, DEFAULT_MANAGED_MODEL);
    assert.equal(body.messages[0]?.content.some((c) => c.type === "image"), true);
  });

  it("throws on a reading it cannot use, so the caller can say so", async () => {
    const client: ModelClient = { toolCall: async () => ({ components: "nope" }) };
    await assert.rejects(
      runManagedDiagramRead({ client, image: IMAGE, model: DEFAULT_MANAGED_MODEL }),
      /unusable diagram reading/,
    );
  });
});

describe("buildGraphModel", () => {
  it("gives repeated kinds distinct ids and an untranslated box a stable id from its ref", () => {
    const { model } = buildGraphModel(
      [
        { ref: "x", label: "Postgres primary", kind: "postgres" },
        { ref: "y", label: "Postgres replica", kind: "postgres" },
        { ref: "Old Mainframe", label: "Old Mainframe" },
      ],
      [],
    );
    assert.deepEqual(model.nodes.filter((n) => n.kind === "postgres").map((n) => n.id), ["postgres", "postgres-2"]);
    assert.equal(model.nodes.find((n) => n.kind === "external")?.id, "external-old-mainframe");
  });
});
