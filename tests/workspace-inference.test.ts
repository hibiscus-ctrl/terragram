// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleModel, MODEL_KIND_IDS } from "terragram-engine/engine";
import {
  ManagedCapReachedError,
  runManagedCompose,
} from "../src/features/workspace/inference.ts";
import { countFlags } from "terragram-engine/model";
import { translateChat, translateRequestSchema } from "../src/features/workspace/translate.ts";

function fakeMint() {
  return { token: "tmpx_test.sig", endpoint: "https://proxy.example.test", expires_at: "2099-01-01T00:00:00Z" };
}

/** Spend-cap reads, stubbed well under the cap so the mint is never the thing
 *  under test. A managed call cannot be made without them. */
const MINT_DEPS = {
  mint: fakeMint,
  cycleSpendPence: async () => 0,
  capPence: async () => 25_000,
};

/** A mint ledger that records nothing, for the tests not about the ledger. */
const noLedger = () => {};

function toolResponse(components: { kind: string; label?: string }[], reply = "Done.") {
  return new Response(
    JSON.stringify({
      content: [{ type: "tool_use", name: "emit_infrastructure", input: { reply, components } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return toolResponse([{ kind: "postgres" }, { kind: "redis-cache" }], "Added a database and cache.");
    }) as unknown as typeof fetch;

    const result = await runManagedCompose({
      orgId: "org_1",
      prompt: "a web app with a database and a cache",
      recordMint: noLedger,
      deps: { fetchImpl, ...MINT_DEPS },
    });

    assert.equal(calls[0]?.url, "https://proxy.example.test/v1/messages");
    assert.equal(result.reply, "Added a database and cache.");
    const kinds = result.model.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("postgres"));
    assert.ok(kinds.includes("redis-cache"));
    assert.ok(kinds.includes("app-service")); // spine scaffolded
    assert.equal(countFlags(result.model), 2); // redis + postgres flagged
  });

  it("forces the emit_infrastructure tool call", async () => {
    let sentBody: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return toolResponse([{ kind: "object-storage" }]);
    }) as unknown as typeof fetch;

    await runManagedCompose({ orgId: "o", prompt: "add a bucket", recordMint: noLedger, deps: { fetchImpl, ...MINT_DEPS } });
    assert.equal(sentBody.tool_choice.name, "emit_infrastructure");
    assert.equal(sentBody.tool_choice.type, "tool");
    assert.ok(Array.isArray(sentBody.tools));
  });

  it("throws on a non-OK gateway response so the caller can fall back", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await assert.rejects(
      runManagedCompose({ orgId: "o", prompt: "x", recordMint: noLedger, deps: { fetchImpl, ...MINT_DEPS } }),
      /managed inference failed/,
    );
  });

  it("throws when the response has no usable tool call", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    await assert.rejects(
      runManagedCompose({ orgId: "o", prompt: "x", recordMint: noLedger, deps: { fetchImpl, ...MINT_DEPS } }),
      /unusable response/,
    );
  });
});

describe("translateChat", () => {
  it("uses the deterministic engine when managed inference is disabled", async () => {
    // WORKSPACE_ENGINE is unset in the test env → managedEngineEnabled() is false.
    const result = await translateChat({
      managedOrgId: "o",
      recordMint: noLedger,
      prompt: "A web app with a Postgres database and Redis cache",
    });
    assert.equal(result.model.nodes.filter((n) => n.category !== "edge").length, 4);
    assert.equal(countFlags(result.model), 2);
  });

  it("stays deterministic when the caller passes no managed-entitled org", async () => {
    const result = await translateChat({
      managedOrgId: null,
      recordMint: noLedger,
      prompt: "A web app with a Postgres database",
    });
    assert.ok(result.model.nodes.some((n) => n.kind === "postgres"));
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

describe("managed attributes and flags", () => {
  it("accepts attribute choices the registry permits", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_infrastructure",
              input: {
                reply: "Sized for production.",
                components: [
                  { kind: "postgres", attributes: { "PostgreSQL version": "PostgreSQL 15" } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await runManagedCompose({
      orgId: "o",
      prompt: "a database on 15",
      recordMint: noLedger,
      deps: { fetchImpl, ...MINT_DEPS },
    });
    const pg = result.model.nodes.find((n) => n.kind === "postgres");
    assert.equal(pg?.attributes?.["PostgreSQL version"], "PostgreSQL 15");
  });

  it("drops an attribute value the provider would reject", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_infrastructure",
              input: {
                reply: "",
                components: [
                  {
                    kind: "postgres",
                    attributes: { "PostgreSQL version": "PostgreSQL 99", Nonsense: "x" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await runManagedCompose({
      orgId: "o",
      prompt: "a database",
      recordMint: noLedger,
      deps: { fetchImpl, ...MINT_DEPS },
    });
    const pg = result.model.nodes.find((n) => n.kind === "postgres");
    assert.equal(pg?.attributes, undefined);
  });

  it("raises the model's own review flag when it says it is unsure", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_infrastructure",
              input: {
                reply: "",
                components: [
                  { kind: "object-storage", flag_reason: "Retention policy was not stated." },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await runManagedCompose({
      orgId: "o",
      prompt: "somewhere to put files",
      recordMint: noLedger,
      deps: { fetchImpl, ...MINT_DEPS },
    });
    const bucket = result.model.nodes.find((n) => n.kind === "object-storage");
    assert.equal(bucket?.flag?.reason, "Retention policy was not stated.");
  });

  it("offers the model the widened vocabulary", async () => {
    let sent: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return toolResponse([{ kind: "queue" }]);
    }) as unknown as typeof fetch;

    await runManagedCompose({ orgId: "o", prompt: "a queue", recordMint: noLedger, deps: { fetchImpl, ...MINT_DEPS } });
    const enumerated: string[] =
      sent.tools[0].input_schema.properties.components.items.properties.kind.enum;
    for (const kind of ["queue", "containers", "monitoring", "vnet", "load-balancer"]) {
      assert.ok(enumerated.includes(kind), `${kind} should be offered to the model`);
    }
    assert.equal(enumerated.includes("internet"), false);
  });
});

describe('managed spend cap', () => {
  /** A fetch that fails the test if it is ever reached: refusing the mint must
   *  happen BEFORE the gateway call, or the money is already spent. */
  const neverCalled = (async () => {
    assert.fail('the gateway was called after the cap was reached');
  }) as unknown as typeof fetch;

  it('refuses to mint once the cycle spend reaches the cap', async () => {
    await assert.rejects(
      runManagedCompose({
        orgId: 'o',
        prompt: 'x',
        recordMint: noLedger,
        deps: {
          fetchImpl: neverCalled,
          mint: fakeMint,
          cycleSpendPence: async () => 25_000,
          capPence: async () => 25_000,
        },
      }),
      ManagedCapReachedError,
    );
  });

  it('treats a cap of zero as managed models off', async () => {
    await assert.rejects(
      runManagedCompose({
        orgId: 'o',
        prompt: 'x',
        recordMint: noLedger,
        deps: {
          fetchImpl: neverCalled,
          mint: fakeMint,
          cycleSpendPence: async () => 0,
          capPence: async () => 0,
        },
      }),
      ManagedCapReachedError,
    );
  });

  it('fails closed when the spend ledger cannot be read', async () => {
    // An unreadable ledger must not mean unbounded spend.
    await assert.rejects(
      runManagedCompose({
        orgId: 'o',
        prompt: 'x',
        recordMint: noLedger,
        deps: {
          fetchImpl: neverCalled,
          mint: fakeMint,
          cycleSpendPence: async () => {
            throw new Error('ledger unavailable');
          },
          capPence: async () => 25_000,
        },
      }),
      /ledger unavailable/,
    );
  });

  it('mints with the remaining budget so the gateway can enforce the cap mid-TTL', async () => {
    let budget: number | undefined;
    const fetchImpl = (async () => toolResponse([{ kind: 'queue' }])) as unknown as typeof fetch;

    await runManagedCompose({
      orgId: 'o',
      prompt: 'a queue',
      recordMint: noLedger,
      deps: {
        fetchImpl,
        mint: (_org: string, _model?: string | null, budgetPence?: number) => {
          budget = budgetPence;
          return fakeMint();
        },
        cycleSpendPence: async () => 20_000,
        capPence: async () => 25_000,
      },
    });

    assert.equal(budget, 5_000);
  });
});

describe("mint ledger", () => {
  /** A ledger that remembers what it was asked to record. */
  function ledger() {
    const rows: { orgId: string; budgetPence: number }[] = [];
    const recordMint = (orgId: string, budgetPence: number) => {
      rows.push({ orgId, budgetPence });
    };
    return { rows, recordMint };
  }

  it("records one row per mint, carrying the org and the budget the token was issued with", async () => {
    const { rows, recordMint } = ledger();
    const fetchImpl = (async () => toolResponse([{ kind: "queue" }])) as unknown as typeof fetch;

    await runManagedCompose({
      orgId: "org_1",
      prompt: "a queue",
      recordMint,
      deps: { ...MINT_DEPS, fetchImpl, cycleSpendPence: async () => 20_000, capPence: async () => 25_000 },
    });

    assert.deepEqual(rows, [{ orgId: "org_1", budgetPence: 5_000 }]);
  });

  it("records nothing when the cap refuses the mint", async () => {
    const { rows, recordMint } = ledger();
    const neverCalled = (async () => assert.fail("the gateway was called")) as unknown as typeof fetch;
    await assert.rejects(
      runManagedCompose({
        orgId: "o",
        prompt: "x",
        recordMint,
        deps: { ...MINT_DEPS, fetchImpl: neverCalled, cycleSpendPence: async () => 25_000 },
      }),
      ManagedCapReachedError,
    );
    assert.deepEqual(rows, []);
  });

  it("records nothing when the mint itself throws", async () => {
    const { rows, recordMint } = ledger();
    await assert.rejects(
      runManagedCompose({
        orgId: "o",
        prompt: "x",
        recordMint,
        deps: {
          ...MINT_DEPS,
          mint: () => {
            throw new Error("model proxy not configured");
          },
        },
      }),
      /not configured/,
    );
    assert.deepEqual(rows, []);
  });

  it("does not fail the managed call when the ledger write throws", async () => {
    // The token is already signed when the ledger runs; a throw escaping would fail
    // a call that minted successfully, and the retry would mint a second token.
    let gatewayCalls = 0;
    const fetchImpl = (async () => {
      gatewayCalls++;
      return toolResponse([{ kind: "queue" }], "Added a queue.");
    }) as unknown as typeof fetch;

    const result = await runManagedCompose({
      orgId: "o",
      prompt: "a queue",
      recordMint: () => {
        throw new Error("usage_events unavailable");
      },
      deps: { fetchImpl, ...MINT_DEPS },
    });

    assert.equal(gatewayCalls, 1);
    assert.equal(result.reply, "Added a queue.");
  });
});
