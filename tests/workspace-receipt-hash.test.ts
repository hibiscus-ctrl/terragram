// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { composeFromPrompt } from "terragram-engine/engine";
import type { Cloud, InfraModel } from "terragram-engine/model";
import { type BundleEntry, buildBundle, contentHashFor, RECEIPT_SCHEMA } from "terragram-engine/receipt";
import { verifyBundle } from "terragram-engine/verify";
import { buildEvidenceReceipt, testSigner } from "./helpers/receipt.ts";
import { nonAsciiModel } from "./helpers/hash-model.ts";

/**
 * The content hash a receipt carries has to be a function of the model and the plan
 * and nothing else: not the machine's locale, and not how the fields happen to be
 * joined. `diagram.receipt/v3` fixes both; `diagram.receipt/v2` receipts, already
 * issued, keep verifying by the hash they were signed under.
 */

const WEB_PROMPT = "A web app with a Postgres database and Redis cache";
const V2 = "diagram.receipt/v2";
const HELPER = fileURLToPath(new URL("./helpers/hash-model.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/receipt-v2/", import.meta.url));

type Args = { model: InfraModel; cloud: Cloud; files: { name: string; content: string }[]; order: string[] };

function argsOf(model: InfraModel, files = [{ name: "main.tf", content: "x" }]): Args {
  return { model, cloud: "azure", files, order: files.map((f) => f.name) };
}

function readTree(dir: string, root = dir): BundleEntry[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? readTree(join(dir, e.name), root)
      : [{ name: relative(root, join(dir, e.name)).split("\\").join("/"), content: readFileSync(join(dir, e.name), "utf8") }],
  );
}

function hashUnder(locale: string) {
  const run = spawnSync(process.execPath, [HELPER], {
    env: { ...process.env, LC_ALL: locale, LANG: locale, LANGUAGE: locale },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as { locale: string; v3: string; v2: string };
}

describe("receipt content hash", () => {
  it("is the same under every process locale, for a model with non-ASCII ids and attribute keys", () => {
    const swedish = hashUnder("sv_SE.UTF-8");
    const english = hashUnder("en_US.UTF-8");
    assert.notEqual(swedish.locale, english.locale, "the subprocesses really ran under different locales");
    assert.equal(swedish.v3, english.v3);
    // The original serialization is the bug this version retires: å sorts after z in
    // Swedish and before b in English, so the same model hashed differently.
    assert.notEqual(swedish.v2, english.v2);
  });

  it("does not depend on the order of nodes, edges or attributes", async () => {
    const model = nonAsciiModel();
    const shuffled: InfraModel = {
      ...model,
      nodes: model.nodes.toReversed().map((n) => ({ ...n, attributes: Object.fromEntries(Object.entries(n.attributes ?? {}).toReversed()) })),
      edges: model.edges.toReversed(),
    };
    assert.equal(await contentHashFor(argsOf(model)), await contentHashFor(argsOf(shuffled)));
  });

  it("changes with any field of the model, the cloud or the plan", async () => {
    const model = nonAsciiModel();
    const base = await contentHashFor(argsOf(model));
    const first = model.nodes[0];
    assert.ok(first && model.edges[0]);
    const variants: Args[] = [
      argsOf({ ...model, nodes: [{ ...first, label: `${first.label}!` }, ...model.nodes.slice(1)] }),
      argsOf({ ...model, nodes: [{ ...first, attributes: { ...first.attributes, q: "1" } }, ...model.nodes.slice(1)] }),
      argsOf({ ...model, nodes: [{ ...first, flag: first.flag ? null : { reason: "unsure" } }, ...model.nodes.slice(1)] }),
      argsOf({ ...model, edges: model.edges.slice(1) }),
      { ...argsOf(model), cloud: "aws" },
      argsOf(model, [{ name: "main.tf", content: "y" }]),
      argsOf(model, [{ name: "other.tf", content: "x" }]),
    ];
    for (const variant of variants) assert.notEqual(await contentHashFor(variant), base);
  });

  it("tells apart models the original serialization wrote identically", async () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const [first, ...rest] = model.nodes;
    assert.ok(first);
    // `p=1,q=2` is one attribute in the first model and two in the second.
    const one: InfraModel = { ...model, nodes: [{ ...first, attributes: { p: "1,q=2" } }, ...rest] };
    const two: InfraModel = { ...model, nodes: [{ ...first, attributes: { p: "1", q: "2" } }, ...rest] };
    // And a label that swallows the field after it.
    const swallowed: InfraModel = { ...model, nodes: [{ ...first, label: "a:k=v", attributes: {} }, ...rest] };
    const split: InfraModel = { ...model, nodes: [{ ...first, label: "a", attributes: { k: "v:" } }, ...rest] };

    for (const [a, b] of [[one, two], [swallowed, split]] as const) {
      assert.equal(await contentHashFor(argsOf(a), V2), await contentHashFor(argsOf(b), V2), "the collision this version removes");
      assert.notEqual(await contentHashFor(argsOf(a)), await contentHashFor(argsOf(b)));
    }
    // Plan text that moves across a file boundary is no longer the same plan.
    const files = (a: string, b: string) => [{ name: "a.tf", content: a }, { name: "b.tf", content: b }];
    assert.equal(await contentHashFor(argsOf(model, files("x\ny", "z")), V2), await contentHashFor(argsOf(model, files("x", "y\nz")), V2));
    assert.notEqual(await contentHashFor(argsOf(model, files("x\ny", "z"))), await contentHashFor(argsOf(model, files("x", "y\nz"))));
  });
});

describe("receipt schema versions", () => {
  it("writes v3 receipts that verify against a trusted key", async () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const built = await buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-09-11T00:00:00Z", { signer: testSigner() });
    assert.equal(built.receipt.schema, "diagram.receipt/v3");
    assert.equal(built.receipt.schema, RECEIPT_SCHEMA);
    const bundle = buildBundle(built.receipt, model, built.terraform.files, built.attestation);
    assert.ok(built.receipt.publicKey);
    const report = await verifyBundle(bundle, { trustedKeys: [built.receipt.publicKey] });
    assert.equal(report.hash.status, "pass", report.hash.detail);
    assert.equal(report.ok, true);
  });

  it("still verifies a v2 receipt issued before v3, signature included", async () => {
    const bundle = readTree(FIXTURE);
    const receipt = JSON.parse(bundle.find((e) => e.name === "receipt.json")?.content ?? "{}") as { schema: string; publicKey: string };
    assert.equal(receipt.schema, V2);
    const report = await verifyBundle(bundle, { trustedKeys: [receipt.publicKey] });
    assert.equal(report.hash.status, "pass", report.hash.detail);
    assert.equal(report.signature.status, "pass", report.signature.detail);
    assert.equal(report.ok, true);
  });

  it("picks the hash by the receipt's schema id, so relabelling a receipt does not verify it", async () => {
    const bundle = readTree(FIXTURE);
    const relabel = (from: string, to: string) =>
      bundle.map((e) => (e.name === "receipt.json" ? { ...e, content: e.content.replace(from, to) } : e));
    assert.equal((await verifyBundle(relabel(V2, RECEIPT_SCHEMA))).hash.status, "fail");
    assert.match((await verifyBundle(relabel(V2, "diagram.receipt/v4"))).error ?? "", /Unrecognised receipt schema: diagram\.receipt\/v4/);
  });

  it("fails a v2 bundle whose plan was changed, as before", async () => {
    const tampered = readTree(FIXTURE).map((e) => (e.name === "plan/main.tf" ? { ...e, content: `${e.content}\n# changed` } : e));
    assert.equal((await verifyBundle(tampered)).hash.status, "fail");
  });
});
