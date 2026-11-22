// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branchName, changeBody, changeFiles, changeTitle, commitMessage, normaliseDirectory } from "../src/features/git/pr.ts";
import { composeFromPrompt } from "terragram-engine/engine";
import { buildEvidenceReceipt } from "../src/features/workspace/sign.ts";

async function approved() {
  delete process.env.EVIDENCE_SIGNING_KEY;
  const { model } = composeFromPrompt("A web app with a Postgres database");
  const { receipt, terraform } = await buildEvidenceReceipt(
    model,
    "azure",
    "deterministic",
    "alice",
    "2026-09-11T10:00:00Z",
  );
  return { model, receipt, terraform };
}

describe("pull request shape", () => {
  it("names the branch by approval day and content hash so approvals never collide", async () => {
    const { receipt } = await approved();
    const name = branchName(receipt);
    assert.match(name, /^terragram\/2026-09-11-[0-9a-f]{10}$/);
    assert.ok(name.includes(receipt.contentHash.replace(/^sha256:/, "").slice(0, 10)));
  });

  it("commits the plan and the receipt beside it under the chosen directory", async () => {
    const { receipt, terraform } = await approved();
    const files = changeFiles(terraform.files, receipt, "infra/terragram");
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("infra/terragram/main.tf"));
    assert.ok(paths.includes("infra/terragram/terragram-receipt.json"));
    const committed = JSON.parse(files.find((f) => f.path.endsWith("receipt.json"))?.content ?? "{}");
    assert.equal(committed.contentHash, receipt.contentHash);
  });

  it("normalises the directory and tolerates the repo root", () => {
    assert.equal(normaliseDirectory(" /infra\\prod/ "), "infra/prod");
    assert.equal(normaliseDirectory("../.."), "");
    assert.equal(normaliseDirectory(""), "");
  });

  it("writes a description carrying the hash, the approver and the verify link", async () => {
    const { model, receipt, terraform } = await approved();
    const files = changeFiles(terraform.files, receipt, "terraform");
    const body = changeBody({ model, receipt, files, verifyUrl: "https://terragram.test/verify" });
    assert.ok(body.includes(receipt.contentHash));
    assert.ok(body.includes("alice"));
    assert.ok(body.includes("https://terragram.test/verify"));
    assert.ok(body.includes("unsigned"), "an unsigned receipt must say so in the PR");
    assert.ok(body.includes("`terraform/main.tf`"));
    assert.ok(body.includes("never applies infrastructure"));
    assert.match(changeTitle(model, receipt), /^Terragram: \d+ Azure resources for review$/);
    assert.match(commitMessage(receipt), /^Add Terragram Terraform plan \([0-9a-f]{10}\)$/);
  });

  it("calls out review flags in the description", async () => {
    const { model, receipt, terraform } = await approved();
    const flagged = {
      ...model,
      nodes: model.nodes.map((n) => (n.kind === "postgres" ? { ...n, flag: { reason: "SKU not stated" } } : n)),
    };
    const body = changeBody({
      model: flagged,
      receipt,
      files: changeFiles(terraform.files, receipt, ""),
      verifyUrl: "https://terragram.test/verify",
    });
    assert.ok(body.includes("**review flag**"));
    assert.ok(body.includes("1 resource carries a review flag"));
  });
});
