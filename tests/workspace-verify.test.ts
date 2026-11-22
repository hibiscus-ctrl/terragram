import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { verifyBytes } from "@infraweaver-io/attest/signing";
import { describe, it } from "node:test";

import { composeFromPrompt } from "../src/features/workspace/engine.ts";
import { explainModel } from "../src/features/workspace/explain.ts";
import { resolvedModel } from "../src/features/workspace/inference.ts";
import { buildBundle, receiptJson } from "../src/features/workspace/receipt.ts";
import { buildEvidenceReceipt } from "../src/features/workspace/sign.ts";
import { readBundleZip, verifyBundle } from "../src/features/workspace/verify.ts";
import { makeZip } from "../src/utils/zip.ts";

/**
 * The promise the evidence bundle makes is that an auditor can check it without us.
 * These tests are that promise: build a bundle, verify it with nothing but its own
 * contents, and confirm that changing a single byte of the plan breaks it.
 */

const WEB_PROMPT = "A web app with a Postgres database and Redis cache";

async function withSigningKey<T>(run: () => Promise<T>): Promise<T> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const previous = process.env.EVIDENCE_SIGNING_KEY;
  process.env.EVIDENCE_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.EVIDENCE_SIGNING_KEY_ID = "test-key";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EVIDENCE_SIGNING_KEY;
    else process.env.EVIDENCE_SIGNING_KEY = previous;
  }
}

async function signedBundle() {
  const { model } = composeFromPrompt(WEB_PROMPT);
  const built = await withSigningKey(() =>
    buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-09-11T00:00:00Z"),
  );
  return {
    model,
    ...built,
    bundle: buildBundle(built.receipt, model, built.terraform.files, built.attestation),
  };
}

describe("evidence bundle", () => {
  it("carries its own public key so it needs nothing from us", async () => {
    const { receipt } = await signedBundle();
    assert.equal(receipt.signed, true);
    assert.ok(receipt.signature);
    assert.ok(receipt.publicKey, "the bundle must carry the key it is checked against");
    assert.equal(receipt.keyId, "test-key");
  });

  it("verifies offline, with the server unreachable", async () => {
    const { bundle } = await signedBundle();
    const report = await verifyBundle(bundle);
    assert.equal(report.hash.status, "pass", report.hash.detail);
    assert.equal(report.signature.status, "pass", report.signature.detail);
    assert.equal(report.ok, true);
  });

  it("fails when a single byte of the plan changes", async () => {
    const { bundle } = await signedBundle();
    const tampered = bundle.map((entry) =>
      entry.name === "plan/main.tf"
        ? { ...entry, content: entry.content.replace("Standard", "Premium") }
        : entry,
    );
    const report = await verifyBundle(tampered);
    assert.equal(report.hash.status, "fail");
    assert.equal(report.ok, false);
  });

  it("fails when the model is swapped for a different one", async () => {
    const { bundle } = await signedBundle();
    const other = composeFromPrompt("A static site").model;
    const tampered = bundle.map((entry) =>
      entry.name === "model.json"
        ? { ...entry, content: JSON.stringify(other, null, 2) }
        : entry,
    );
    const report = await verifyBundle(tampered);
    assert.equal(report.hash.status, "fail");
    assert.equal(report.ok, false);
  });

  it("reports the hash as not-checked when given the receipt alone", async () => {
    const { bundle } = await signedBundle();
    const receiptOnly = bundle.filter((e) => e.name === "receipt.json");
    const report = await verifyBundle(receiptOnly);
    // Not a pass and not a failure: we were not given enough to check the contents,
    // and saying so is the only honest answer.
    assert.equal(report.hash.status, "unavailable");
    assert.equal(report.signature.status, "pass");
    assert.equal(report.ok, false);
  });

  it("says a receipt is unsigned rather than implying it was verified", async () => {
    delete process.env.EVIDENCE_SIGNING_KEY;
    const { model } = composeFromPrompt(WEB_PROMPT);
    const { receipt, terraform } = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "alice",
      "2026-09-11T00:00:00Z",
    );
    const report = await verifyBundle(buildBundle(receipt, model, terraform.files));
    assert.equal(report.hash.status, "pass");
    assert.equal(report.signature.status, "unavailable");
    assert.match(report.signature.detail, /unsigned/);
  });

  it("rejects an unrecognised schema instead of guessing", async () => {
    const report = await verifyBundle([
      { name: "receipt.json", content: JSON.stringify({ schema: "something/else" }) },
    ]);
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /schema/);
  });

  it("includes the description the approver read", async () => {
    const { bundle, model } = await signedBundle();
    const explanation = bundle.find((e) => e.name === "explanation.txt");
    assert.ok(explanation);
    assert.equal(explanation?.content.trim(), explainModel(model, "azure", "UK South").trim());
  });
});

describe("bundle zip round-trip", () => {
  it("reads back exactly what the workspace's zip writer produced", async () => {
    const { bundle } = await signedBundle();
    // The reader and the writer are the two halves of the download, and they are the
    // one seam a unit test of either half alone would miss.
    const blob = makeZip(bundle);
    const file = new File([await blob.arrayBuffer()], "terragram-evidence.zip");
    const entries = await readBundleZip(file);

    assert.deepEqual(
      entries.map((e) => e.name).sort(),
      bundle.map((e) => e.name).sort(),
    );
    for (const original of bundle) {
      const read = entries.find((e) => e.name === original.name);
      assert.equal(read?.content, original.content, `${original.name} did not survive the zip`);
    }

    const report = await verifyBundle(entries);
    assert.equal(report.ok, true, report.hash.detail);
  });
});

/**
 * Provenance and the detached signature — the two things the receipt gained by
 * adopting `@infraweaver-io/attest`'s envelope frame.
 *
 * The point of the provenance section is not the values it carries on a good day.
 * It is that a bundle can now state what did NOT happen: no model chose the
 * components, no scanner ran. Before it, "this was never scanned" and "we forgot
 * to record it" were the same bundle.
 */
describe("receipt provenance", () => {
  it("says which runtime produced it, and that nothing scanned it", async () => {
    const { receipt } = await signedBundle();
    assert.equal(receipt.schema, "terragram.receipt/v2");
    assert.equal(receipt.provenance.node, process.version);
    assert.deepEqual(
      receipt.provenance.scanners,
      [],
      "Terragram runs no scanner at generation time, and the bundle has to be able to say so",
    );
  });

  it("names no model for the deterministic engine, and the resolved one for managed", async () => {
    const { model } = composeFromPrompt(WEB_PROMPT);
    const deterministic = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "alice",
      "2026-09-12T00:00:00Z",
    );
    assert.equal(
      deterministic.receipt.provenance.model,
      null,
      "no model chose anything — the kind registry did",
    );

    const managed = await buildEvidenceReceipt(
      model,
      "azure",
      "managed",
      "alice",
      "2026-09-12T00:00:00Z",
    );
    assert.equal(managed.receipt.provenance.model, resolvedModel());
  });

  it("records the model the turn ran on, not the one configured now", async () => {
    // The whole claim of the provenance block is that "which model produced this
    // plan" is answerable from the bundle alone. Once a user can pick a model, a
    // receipt that re-resolves from configuration answers a different question and
    // gets it wrong: approve an Opus turn on a Sonnet-default deployment and the
    // receipt would name Sonnet.
    const { model } = composeFromPrompt(WEB_PROMPT);
    const opus = await buildEvidenceReceipt(
      model,
      "azure",
      "managed",
      "alice",
      "2026-09-13T00:00:00Z",
      { inferenceModel: "claude-opus-5-5" },
    );
    assert.equal(opus.receipt.provenance.model, "claude-opus-5-5");
    assert.notEqual(opus.receipt.provenance.model, resolvedModel());

    // The deterministic engine still records null however it is called — no model
    // chose anything, so naming one would be the same lie in the other direction.
    const deterministic = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "alice",
      "2026-09-13T00:00:00Z",
      { inferenceModel: "claude-opus-5-5" },
    );
    assert.equal(deterministic.receipt.provenance.model, null);
  });

  it("still verifies a receipt written before provenance existed", async () => {
    const { bundle } = await signedBundle();
    const downgraded = bundle.map((entry) =>
      entry.name === "receipt.json"
        ? { ...entry, content: entry.content.replace("terragram.receipt/v2", "terragram.receipt/v1") }
        : entry,
    );
    const report = await verifyBundle(downgraded);
    // The hash covers the model and the plan, neither of which the schema bump
    // touched — so refusing an older bundle would be a choice, not a limitation.
    assert.equal(report.hash.status, "pass", report.hash.detail);
  });
});

describe("detached signature for the command-line verifier", () => {
  it("ships a .sig and a PEM beside the receipt, over its exact bytes", async () => {
    const { bundle, receipt } = await signedBundle();
    const sig = bundle.find((e) => e.name === "receipt.json.sig");
    const pem = bundle.find((e) => e.name === "signing-key.pem");
    assert.ok(sig, "the bundle carries a detached signature");
    assert.ok(pem?.content.includes("-----BEGIN PUBLIC KEY-----"), "and the key to check it with");

    // Exactly the form `infraweaver verify-evidence <bundle> <sig> <pubkey>` reads:
    // the signature covers receipt.json's bytes verbatim, not a field inside it.
    const bytes = bundle.find((e) => e.name === "receipt.json")?.content ?? "";
    assert.equal(bytes, receiptJson(receipt));
    assert.equal(verifyBytes(bytes, sig!.content.trim(), pem!.content), true);
    assert.equal(verifyBytes(`${bytes} `, sig!.content.trim(), pem!.content), false);
  });

  it("ships neither when no key is configured, rather than an unsigned placeholder", async () => {
    delete process.env.EVIDENCE_SIGNING_KEY;
    const { model } = composeFromPrompt(WEB_PROMPT);
    const built = await buildEvidenceReceipt(
      model,
      "azure",
      "deterministic",
      "alice",
      "2026-09-12T00:00:00Z",
    );
    assert.equal(built.attestation, null);
    const bundle = buildBundle(built.receipt, model, built.terraform.files, built.attestation);
    assert.equal(bundle.some((e) => e.name.endsWith(".sig")), false);
    assert.equal(bundle.some((e) => e.name.endsWith(".pem")), false);
  });
});
