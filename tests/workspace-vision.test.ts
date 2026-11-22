// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGraphModel } from "../src/features/workspace/graph-build.ts";
import { buildImageRequest, modelFromReading, runManagedDiagramRead } from "../src/features/workspace/vision.ts";

const IMAGE = { data: "aGVsbG8=", mediaType: "image/png" as const };

const MINT_DEPS = {
  mint: () => ({ token: "tmpx_test.sig", endpoint: "https://proxy.example.test", expires_at: "2099-01-01T00:00:00Z" }),
  cycleSpendPence: async () => 0,
  capPence: async () => 25_000,
};

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
  it("posts the image through the managed gateway and reads the tool call back", async () => {
    const seen: { body?: { messages: Array<{ content: Array<{ type: string }> }> } } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_diagram",
              input: {
                reply: "ok",
                components: [{ ref: "a1", label: "Postgres", kind: "postgres" }],
                connections: [],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await runManagedDiagramRead({ orgId: "o", image: IMAGE, recordMint: () => {}, deps: { fetchImpl, ...MINT_DEPS } });
    assert.ok(result.model.nodes.some((n) => n.kind === "postgres"));
    assert.equal(seen.body?.messages[0]?.content.some((c) => c.type === "image"), true);
  });

  it("refuses over the spend cap before any image is sent", async () => {
    const fetchImpl = (async () => assert.fail("the gateway was called")) as unknown as typeof fetch;
    await assert.rejects(
      runManagedDiagramRead({
        orgId: "o",
        image: IMAGE,
        recordMint: () => {},
        deps: { fetchImpl, mint: MINT_DEPS.mint, cycleSpendPence: async () => 25_000, capPence: async () => 25_000 },
      }),
      /spend cap/,
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

describe("diagram read mint ledger", () => {
  it("records the mint the diagram read made, like a chat turn", async () => {
    const rows: { orgId: string; budgetPence: number }[] = [];
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "emit_diagram", input: { reply: "", components: [], connections: [] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    await runManagedDiagramRead({
      orgId: "org_1",
      image: IMAGE,
      recordMint: (orgId, budgetPence) => rows.push({ orgId, budgetPence }),
      deps: { fetchImpl, ...MINT_DEPS },
    });

    assert.deepEqual(rows, [{ orgId: "org_1", budgetPence: 25_000 }]);
  });
});
