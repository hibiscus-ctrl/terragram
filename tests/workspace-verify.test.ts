// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";

import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";

import { composeFromPrompt } from "terragram-engine/engine";
import { addNode } from "terragram-engine/inspector";
import { EMPTY_MODEL } from "terragram-engine/model";
import { explainModel } from "terragram-engine/explain";
import { DEFAULT_MANAGED_MODEL } from "terragram-engine/managed-models";
import { buildBundle, receiptJson } from "terragram-engine/receipt";
import { buildEvidenceReceipt, testSigner } from "./helpers/receipt.ts";
import { readBundleZip, verifyBundle } from "terragram-engine/verify";
import { makeZip } from "./helpers/zip.ts";

/**
 * The promise the evidence bundle makes is that an auditor can check it without us.
 * These tests are that promise: build a bundle, verify it with nothing but its own
 * contents, and confirm that changing a single byte of the plan breaks it.
 */

const WEB_PROMPT = "A web app with a Postgres database and Redis cache";

/** A detached Ed25519 signature (base64) over exactly these bytes, checked against an SPKI PEM public key. */
function verifyBytes(bytes: string, signatureB64: string, publicKeyPem: string): boolean {
  return verify(null, Buffer.from(bytes, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
}

async function signedBundle() {
  const { model } = composeFromPrompt(WEB_PROMPT);
  const built = await buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-09-11T00:00:00Z", {
    signer: testSigner(),
  });
  return {
    model,
    ...built,
    bundle: buildBundle(built.receipt, model, built.terraform.files, built.attestation),
  };
}

/** The key a host would hold for the signer, apart from the bundle. */
function trusting(receipt: { publicKey?: string | null }) {
  assert.ok(receipt.publicKey);
  return { trustedKeys: [receipt.publicKey] };
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
    const { bundle, receipt } = await signedBundle();
    const report = await verifyBundle(bundle, trusting(receipt));
    assert.equal(report.hash.status, "pass", report.hash.detail);
    assert.equal(report.signature.status, "pass", report.signature.detail);
    assert.equal(report.ok, true);
  });

  it("is not ok without a trusted key, however well the bundle signs itself", async () => {
    const { bundle } = await signedBundle();
    const report = await verifyBundle(bundle);
    assert.equal(report.hash.status, "pass");
    assert.equal(report.signature.status, "unavailable");
    assert.equal(report.ok, false);
  });

  it("is ok on the bundle's own key only when the caller opts out of trusting one", async () => {
    const { bundle } = await signedBundle();
    const report = await verifyBundle(bundle, { acceptBundledKey: true });
    assert.equal(report.signature.status, "pass");
    assert.match(report.signature.detail, /not independently trusted/);
    assert.equal(report.ok, true);
  });

  it("fails a forged bundle re-signed with the forger's own key", async () => {
    const genuine = await signedBundle();
    const forged = await signedBundle();
    const report = await verifyBundle(forged.bundle, trusting(genuine.receipt));
    assert.equal(report.hash.status, "pass");
    assert.equal(report.signature.status, "fail");
    assert.equal(report.ok, false);
    // Opting out of trust would have waved it through, which is why it is not the default.
    assert.equal((await verifyBundle(forged.bundle, { acceptBundledKey: true })).ok, true);
  });

  it("accepts a trusted key given as a PEM block", async () => {
    const { bundle, receipt } = await signedBundle();
    const pem = `-----BEGIN PUBLIC KEY-----\n${receipt.publicKey}\n-----END PUBLIC KEY-----\n`;
    assert.equal((await verifyBundle(bundle, { trustedKeys: [pem] })).ok, true);
  });

  it("fails a receipt that says it is signed but carries no signature", async () => {
    const { bundle } = await signedBundle();
    const stripped = bundle.map((entry) => {
      if (entry.name !== "receipt.json") return entry;
      const receipt = JSON.parse(entry.content);
      receipt.signature = null;
      return { ...entry, content: JSON.stringify(receipt) };
    });
    for (const options of [{}, { acceptBundledKey: true }]) {
      const report = await verifyBundle(stripped, options);
      assert.equal(report.signature.status, "fail");
      assert.equal(report.ok, false);
    }
  });

  it("fails an unsigned receipt when a trusted key is required", async () => {
    const { receipt: signed } = await signedBundle();
    const { model } = composeFromPrompt(WEB_PROMPT);
    const { receipt, terraform } = await buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-09-11T00:00:00Z");
    const report = await verifyBundle(buildBundle(receipt, model, terraform.files), trusting(signed));
    assert.equal(report.signature.status, "fail");
    assert.equal(report.ok, false);
  });

  it("fails when a single byte of the plan changes", async () => {
    const { bundle } = await signedBundle();
    const tampered = bundle.map((entry) =>
      entry.name === "plan/main.tf"
        ? { ...entry, content: entry.content.replace("Standard", "Premium") }
        : entry,
    );
    const report = await verifyBundle(tampered, { acceptBundledKey: true });
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
    const report = await verifyBundle(tampered, { acceptBundledKey: true });
    assert.equal(report.hash.status, "fail");
    assert.equal(report.ok, false);
  });

  it("returns a failure report, not a rejection, for a model.json that is not JSON", async () => {
    const { bundle } = await signedBundle();
    const broken = bundle.map((entry) => (entry.name === "model.json" ? { ...entry, content: "{ not json" } : entry));
    const report = await verifyBundle(broken, { acceptBundledKey: true });
    assert.equal(report.ok, false);
    assert.equal(report.hash.status, "fail");
    assert.match(report.error ?? "", /model\.json is not valid JSON/);
  });

  it("reports the hash as not-checked when given the receipt alone", async () => {
    const { bundle } = await signedBundle();
    const receiptOnly = bundle.filter((e) => e.name === "receipt.json");
    const report = await verifyBundle(receiptOnly, { acceptBundledKey: true });
    // Not a pass and not a failure: we were not given enough to check the contents,
    // and saying so is the only honest answer.
    assert.equal(report.hash.status, "unavailable");
    assert.equal(report.signature.status, "pass");
    assert.equal(report.ok, false);
  });

  it("says a receipt is unsigned rather than implying it was verified", async () => {
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
  it("reads back exactly what a zip writer produced", async () => {
    const { bundle, receipt } = await signedBundle();
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

    const report = await verifyBundle(entries, trusting(receipt));
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
    assert.equal(receipt.schema, "diagram.receipt/v2");
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
    assert.equal(managed.receipt.provenance.model, DEFAULT_MANAGED_MODEL);
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
    assert.notEqual(opus.receipt.provenance.model, DEFAULT_MANAGED_MODEL);

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

  for (const [name, oldId] of [
    ["before provenance existed", "terragram.receipt/v1"],
    ["under the codename schema id", "terragram.receipt/v2"],
  ] as const) {
    it(`verifies a receipt written ${name} only when the caller accepts its id`, async () => {
      const { bundle } = await signedBundle();
      const older = bundle.map((entry) =>
        entry.name === "receipt.json"
          ? { ...entry, content: entry.content.replace("diagram.receipt/v2", oldId) }
          : entry,
      );
      assert.equal((await verifyBundle(older)).error, `Unrecognised receipt schema: ${oldId}.`);
      const report = await verifyBundle(older, { alsoAccept: [oldId] });
      // The hash covers the model and the plan, neither of which the schema id
      // touched — so refusing an older bundle would be a choice, not a limitation.
      assert.equal(report.hash.status, "pass", report.hash.detail);
    });
  }

  it("refuses a receipt with a schema id it never wrote", async () => {
    const { bundle } = await signedBundle();
    const foreign = bundle.map((entry) =>
      entry.name === "receipt.json"
        ? { ...entry, content: entry.content.replace("diagram.receipt/v2", "diagram.receipt/v9") }
        : entry,
    );
    const report = await verifyBundle(foreign);
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /Unrecognised receipt schema/);
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

  it("ships neither when no signer is configured, rather than an unsigned placeholder", async () => {
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

describe("bundle entry names", () => {
  it("reads receipt.json by its exact name, never a look-alike", async () => {
    const { bundle } = await signedBundle();
    const receipt = bundle.find((e) => e.name === "receipt.json")!;
    const decoy = { name: "old-receipt.json", content: JSON.stringify({ schema: "something/else" }) };
    const report = await verifyBundle([decoy, ...bundle], { acceptBundledKey: true });
    assert.equal(report.ok, true, report.hash.detail);
    assert.equal(report.receipt?.contentHash, JSON.parse(receipt.content).contentHash);
  });

  it("refuses a bundle that holds a file name twice", async () => {
    const { bundle } = await signedBundle();
    for (const name of ["receipt.json", "model.json", "plan/main.tf"]) {
      const twice = [...bundle, bundle.find((e) => e.name === name)!];
      const report = await verifyBundle(twice);
      assert.equal(report.ok, false);
      assert.equal(report.error, `The bundle holds more than one ${name}.`);
    }
  });

  it("refuses a plan file the receipt does not record, in plan/ or a sub-folder", async () => {
    const { bundle } = await signedBundle();
    for (const name of ["plan/extra.tf", "plan/extra/main.tf"]) {
      const report = await verifyBundle([...bundle, { name, content: "" }], { acceptBundledKey: true });
      assert.equal(report.ok, false);
      assert.match(report.error ?? "", /not one the receipt records/);
    }
  });

  it("refuses plan file names that leave plan/ or are not plain relative paths", async () => {
    const { bundle } = await signedBundle();
    for (const name of ["plan/../model.json", "plan/a/../b.tf", "plan//main.tf", "plan/a//b.tf", "plan//etc/passwd", "plan/a\\b.tf", "plan/./main.tf", "plan/"]) {
      const report = await verifyBundle([...bundle.filter((e) => e.name !== name), { name, content: "" }], { acceptBundledKey: true });
      assert.equal(report.ok, false, name);
      assert.match(report.error ?? "", /plan file name is not allowed/, name);
    }
  });

  it("verifies a bundle that carries a function's handler under plan/src/", async () => {
    const added = addNode(EMPTY_MODEL, "functions");
    assert.ok(added);
    const built = await buildEvidenceReceipt(added.model, "aws", "deterministic", "alice", "2026-09-11T00:00:00Z", {
      signer: testSigner(),
    });
    const bundle = buildBundle(built.receipt, added.model, built.terraform.files, built.attestation);
    assert.ok(bundle.some((e) => e.name === "plan/src/functions/index.mjs"));
    const report = await verifyBundle(bundle, trusting(built.receipt));
    assert.equal(report.hash.status, "pass", report.hash.detail);
    assert.equal(report.ok, true, report.error ?? report.signature.detail);

    // The handler is hashed: changing it breaks the bundle.
    const tampered = bundle.map((e) => (e.name === "plan/src/functions/index.mjs" ? { ...e, content: `${e.content}// x\n` } : e));
    assert.equal((await verifyBundle(tampered, trusting(built.receipt))).hash.status, "fail");
  });

  it("reads a bundle zipped from its folder", async () => {
    const { bundle } = await signedBundle();
    const nested = bundle.map((e) => ({ ...e, name: `bundle/${e.name}` }));
    const file = new File([await makeZip(nested).arrayBuffer()], "bundle.zip");
    const entries = await readBundleZip(file);
    assert.deepEqual(entries.map((e) => e.name).sort(), bundle.map((e) => e.name).sort());
    assert.equal((await verifyBundle(entries, { acceptBundledKey: true })).ok, true);
  });

  it("keeps names as they are when the entries do not share one folder", async () => {
    const file = new File(
      [await makeZip([{ name: "a/receipt.json", content: "{}" }, { name: "b/model.json", content: "{}" }]).arrayBuffer()],
      "mixed.zip",
    );
    const entries = await readBundleZip(file);
    assert.deepEqual(entries.map((e) => e.name).sort(), ["a/receipt.json", "b/model.json"]);
    assert.equal((await verifyBundle(entries)).error, "No receipt.json found in what you provided.");
  });
});
