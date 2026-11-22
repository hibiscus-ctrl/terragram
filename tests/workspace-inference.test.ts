// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleModel, MODEL_KIND_IDS } from "terragram-engine/engine";
import { extractToolUse, runManagedCompose, toolNameOf } from "terragram-engine/managed-compose";
import { DEFAULT_MANAGED_MODEL } from "terragram-engine/managed-models";
import { countFlags } from "terragram-engine/model";
import { type Logger, ManagedCapReachedError, type MessagesRequest, type ModelClient } from "terragram-engine/ports";
import { translateRequestSchema, translateWithFallback } from "terragram-engine/translate";

/** A `ModelClient` that answers every call with `output` and remembers the requests. */
function clientReturning(output: unknown) {
  const requests: MessagesRequest[] = [];
  const client: ModelClient = {
    async toolCall(request) {
      requests.push(request);
      return output;
    },
  };
  return { client, requests };
}

function toolOutput(components: { kind: string; label?: string; attributes?: Record<string, string>; flag_reason?: string }[], reply = "Done.") {
  return { reply, components };
}

function run(client: ModelClient, prompt: string) {
  return runManagedCompose({ client, prompt, model: DEFAULT_MANAGED_MODEL });
}

describe("assembleModel", () => {
  it("keeps a coherent spine and re-derives edges from a bare kind list", () => {
    const { model } = assembleModel(["postgres", "redis-cache"]);
    const kinds = model.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["app-service", "front-door", "internet", "postgres", "redis-cache"]);
    assert.ok(model.edges.some((e) => e.source === "internet" && e.target === "front-door"));
    assert.ok(model.edges.some((e) => e.source === "app-service" && e.target === "postgres"));
  });

  it("ignores unknown kinds and the conceptual internet kind", () => {
    const { model } = assembleModel(["not-a-real-kind", "internet", "postgres"]);
    assert.ok(model.nodes.every((n) => MODEL_KIND_IDS.includes(n.kind) || n.kind === "internet"));
    assert.ok(model.nodes.some((n) => n.kind === "postgres"));
  });
});

describe("runManagedCompose", () => {
  it("turns the forced tool call into a model the emitter understands", async () => {
    const { client } = clientReturning(
      toolOutput([{ kind: "postgres" }, { kind: "redis-cache" }], "Added a database and cache."),
    );
    const result = await run(client, "a web app with a database and a cache");

    assert.equal(result.reply, "Added a database and cache.");
    assert.equal(result.engine, "managed");
    assert.equal(result.inferenceModel, DEFAULT_MANAGED_MODEL);
    const kinds = result.model.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("postgres"));
    assert.ok(kinds.includes("redis-cache"));
    assert.ok(kinds.includes("app-service")); // spine scaffolded
    assert.equal(countFlags(result.model), 2); // redis + postgres flagged
  });

  it("forces the emit_infrastructure tool call on the model it was given", async () => {
    const { client, requests } = clientReturning(toolOutput([{ kind: "object-storage" }]));
    await runManagedCompose({ client, prompt: "add a bucket", model: "claude-opus-5-5" });
    const sent = requests[0] as { model: string; tool_choice: { type: string; name: string }; tools: unknown[] };
    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.tool_choice.name, "emit_infrastructure");
    assert.equal(sent.tool_choice.type, "tool");
    assert.ok(Array.isArray(sent.tools));
  });

  it("tells the model which components are already present", async () => {
    const { model: prev } = assembleModel(["postgres"]);
    const { client, requests } = clientReturning(toolOutput([{ kind: "queue" }]));
    await runManagedCompose({ client, prompt: "add a queue", prev, model: DEFAULT_MANAGED_MODEL });
    const messages = (requests[0] as unknown as { messages: { content: string }[] }).messages;
    assert.match(messages[0]?.content ?? "", /^Current components: .*postgres/);
    assert.match(messages[0]?.content ?? "", /Instruction: add a queue$/);
  });

  it("throws when the response has no usable tool call, so the caller can fall back", async () => {
    await assert.rejects(run(clientReturning(null).client, "x"), /unusable response/);
    await assert.rejects(run(clientReturning({ components: "nope" }).client, "x"), /unusable response/);
  });

  it("describes the turn itself when the model gives no reply", async () => {
    const result = await run(clientReturning(toolOutput([{ kind: "queue" }], "  ")).client, "a queue");
    assert.notEqual(result.reply, "");
  });

  it("reports the cloud the model read from the description", async () => {
    const { client } = clientReturning({ reply: "ok", cloud: "aws", components: [{ kind: "queue" }] });
    assert.equal((await run(client, "an SQS queue")).cloud, "aws");
  });
});

describe("managed attributes and flags", () => {
  it("accepts attribute choices the registry permits", async () => {
    const { client } = clientReturning(
      toolOutput(
        [{ kind: "postgres", attributes: { "PostgreSQL version": "PostgreSQL 15" } }],
        "Sized for production.",
      ),
    );
    const result = await run(client, "a database on 15");
    const pg = result.model.nodes.find((n) => n.kind === "postgres");
    assert.equal(pg?.attributes?.["PostgreSQL version"], "PostgreSQL 15");
  });

  it("drops an attribute value the provider would reject", async () => {
    const { client } = clientReturning(
      toolOutput([{ kind: "postgres", attributes: { "PostgreSQL version": "PostgreSQL 99", Nonsense: "x" } }], ""),
    );
    const result = await run(client, "a database");
    const pg = result.model.nodes.find((n) => n.kind === "postgres");
    assert.equal(pg?.attributes, undefined);
  });

  it("raises the model's own review flag when it says it is unsure", async () => {
    const { client } = clientReturning(
      toolOutput([{ kind: "object-storage", flag_reason: "Retention policy was not stated." }], ""),
    );
    const result = await run(client, "somewhere to put files");
    const bucket = result.model.nodes.find((n) => n.kind === "object-storage");
    assert.equal(bucket?.flag?.reason, "Retention policy was not stated.");
  });

  it("offers the model the widened vocabulary", async () => {
    const { client, requests } = clientReturning(toolOutput([{ kind: "queue" }]));
    await run(client, "a queue");
    const sent = requests[0] as unknown as {
      tools: { input_schema: { properties: { components: { items: { properties: { kind: { enum: string[] } } } } } } }[];
    };
    const enumerated = sent.tools[0]?.input_schema.properties.components.items.properties.kind.enum ?? [];
    for (const kind of ["queue", "containers", "monitoring", "vnet", "load-balancer"]) {
      assert.ok(enumerated.includes(kind), `${kind} should be offered to the model`);
    }
    assert.equal(enumerated.includes("internet"), false);
  });
});

describe("tool-call transport helpers", () => {
  const response = {
    content: [
      { type: "text", text: "thinking" },
      { type: "tool_use", name: "emit_infrastructure", input: { reply: "hi" } },
    ],
  };

  it("reads the named tool's input out of a Messages response", () => {
    assert.deepEqual(extractToolUse(response, "emit_infrastructure"), { reply: "hi" });
  });

  it("returns null when the response carries no such tool call", () => {
    assert.equal(extractToolUse(response, "other_tool"), null);
    assert.equal(extractToolUse({ content: "nope" }, "emit_infrastructure"), null);
    assert.equal(extractToolUse(null, "emit_infrastructure"), null);
    assert.equal(extractToolUse("text", "emit_infrastructure"), null);
  });

  it("names the tool a request forces, defaulting to the compose tool", () => {
    assert.equal(toolNameOf({ model: "m", tool_choice: { type: "tool", name: "emit_diagram" } }), "emit_diagram");
    assert.equal(toolNameOf({ model: "m" }), "emit_infrastructure");
  });
});

describe("translateRequestSchema", () => {
  it("accepts a prompt with an optional prior model", () => {
    const ok = translateRequestSchema.safeParse({ prompt: "add redis" });
    assert.equal(ok.success, true);
  });

  it("rejects an empty prompt", () => {
    const bad = translateRequestSchema.safeParse({ prompt: "" });
    assert.equal(bad.success, false);
  });
});

describe("translateWithFallback", () => {
  const PROMPT = "A web app with a Postgres database and Redis cache";

  function logger() {
    const lines: { level: "info" | "error"; message: string }[] = [];
    const log: Logger = {
      info: (message) => lines.push({ level: "info", message }),
      error: (message) => lines.push({ level: "error", message }),
    };
    return { log, lines };
  }

  it("uses the deterministic engine when the host runs no managed turn", async () => {
    const { log, lines } = logger();
    const result = await translateWithFallback({ prompt: PROMPT, managed: null, log });
    assert.equal(result.model.nodes.filter((n) => n.category !== "edge").length, 4);
    assert.equal(countFlags(result.model), 2);
    assert.deepEqual(lines, []);
  });

  it("returns the managed answer when it succeeds", async () => {
    const { log } = logger();
    const managed = () => run(clientReturning(toolOutput([{ kind: "queue" }], "Added a queue.")).client, "a queue");
    const result = await translateWithFallback({ prompt: "a queue", managed, log });
    assert.equal(result.engine, "managed");
    assert.equal(result.reply, "Added a queue.");
  });

  it("falls back to the deterministic engine and logs an error when the managed turn fails", async () => {
    const { log, lines } = logger();
    const result = await translateWithFallback({
      prompt: "A web app with a Postgres database",
      managed: async () => {
        throw new Error("gateway down");
      },
      log,
    });
    assert.ok(result.model.nodes.some((n) => n.kind === "postgres"));
    assert.deepEqual(lines.map((l) => l.level), ["error"]);
  });

  it("logs a reached spend cap as information, not as a failure", async () => {
    const { log, lines } = logger();
    const result = await translateWithFallback({
      prompt: "A web app with a Postgres database",
      managed: async () => {
        throw new ManagedCapReachedError();
      },
      log,
    });
    assert.ok(result.model.nodes.some((n) => n.kind === "postgres"));
    assert.deepEqual(lines.map((l) => l.level), ["info"]);
  });
});
