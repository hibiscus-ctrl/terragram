// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only


import { relative, sep } from "node:path";

import { buildEvidenceReceipt } from "terragram-engine/build-receipt";
import { assessFeasibility } from "terragram-engine/feasibility";
import { resourceNodes } from "terragram-engine/model";
import { buildBundle } from "terragram-engine/receipt";
import { emitTerraform } from "terragram-engine/terraform";

import { type CommentTarget, GitHubApiError, upsertStickyComment } from "./comment.ts";
import { readInputs, resolveInside } from "./inputs.ts";
import { renderDiagram } from "./mermaid.ts";
import { readRegularFile } from "./safe-fs.ts";
import { diffModels } from "./model-diff.ts";
import { parseModelDocument } from "./model-file.ts";
import { type BaseModel, readBaseModel, readPullRequest } from "./pull-request.ts";
import { type BaseState, commentBody, renderReport } from "./report.ts";
import { loadSigner, maskableParts } from "./signer.ts";
import { compareFiles, replaceDirectory, writeFiles } from "./terraform-files.ts";
import { pushSkipReason } from "./push.ts";
import { uploadBundle } from "./upload.ts";
import { ActionError, createWorkflow, type Host, type Workflow } from "./workflow.ts";

/** Where the receipt bundle goes, under the workspace: for `terragram verify` and upload-artifact. */
const BUNDLE_DIR = "_diagram";

/** The one event whose model can be an approved one, so the only one the bundle is uploaded from (and then only on the default branch). */
const UPLOAD_EVENT = "push";

/**
 * Run the Action and return the process exit status: 0, or 1 when the step failed (a check
 * that found drift, or anything the Action could not do). Outputs are written before it fails.
 */
export async function run(host: Host): Promise<number> {
  const workflow = createWorkflow(host);
  try {
    return await execute(host, workflow);
  } catch (error) {
    workflow.error(error instanceof ActionError ? error.message : `unexpected error: ${(error as Error).message ?? String(error)}`);
    return 1;
  }
}

async function execute(host: Host, workflow: Workflow): Promise<number> {
  const inputs = readInputs(host.env);
  const eventName = host.env.GITHUB_EVENT_NAME ?? "";
  if (eventName === "pull_request_target") {
    throw new ActionError(
      "this Action must not run under pull_request_target: that trigger gives a pull request's files a token with write access. Use pull_request.",
    );
  }
  if (inputs.signingKey) for (const part of maskableParts(inputs.signingKey)) workflow.mask(part);

  const root = host.env.GITHUB_WORKSPACE || host.cwd;
  const modelPath = resolveInside(root, inputs.model, "model");
  const terraformDir = resolveInside(root, inputs.terraformDir, "terraform-dir");
  const bundleDir = resolveInside(root, BUNDLE_DIR, "receipt directory");

  let text: string;
  try {
    text = readRegularFile(root, modelPath, inputs.model);
  } catch {
    throw new ActionError(`cannot read the model file ${inputs.model}`);
  }
  const parsed = parseModelDocument(text);
  if (!parsed.ok) throw new ActionError(`${inputs.model}: ${parsed.problem}`);
  const { model, cloud } = parsed.document;
  if (resourceNodes(model).length === 0) throw new ActionError(`${inputs.model} has no components to build`);

  // The Terraform the model says, regenerated in memory: nothing is written to the
  // terraform directory in check mode.
  const terraform = emitTerraform(model, cloud, "terraform");
  const files = compareFiles(root, terraformDir, inputs.terraformDir, terraform.files);
  const drifted = files.filter((f) => f.status !== "same");
  const written = inputs.mode === "write" ? writeFiles(root, terraformDir, terraform.files, files) : [];

  const signer = inputs.signingKey ? loadSigner(inputs.signingKey, host.now().toISOString()) : null;
  const { receipt, attestation } = await buildEvidenceReceipt(model, cloud, "deterministic", "diagram-action", host.now().toISOString(), {
    tool: "terraform",
    signer,
    nodeVersion: process.version,
  });
  const bundleFiles = buildBundle(receipt, model, terraform.files, attestation);
  replaceDirectory(root, bundleDir, bundleFiles);
  const receiptPath = `${BUNDLE_DIR}/receipt.json`;

  const feasibility = assessFeasibility(model, cloud);
  const warnings = feasibility.components
    .filter((c) => c.status !== "buildable")
    .map((c) => `${c.label || c.id}: ${c.reason ?? "needs review"}`);

  // The pull request, when there is one: the model as the base had it, and what that changes.
  const pr = readPullRequest(host);
  let base: BaseState = { state: "none" };
  let diff = null;
  let terraformChanged: string[] = [];
  if (pr) {
    const baseModel: BaseModel = readBaseModel(host, root, pr.baseSha, modelPath);
    if (baseModel.state === "unavailable") {
      base = { state: "unavailable", reason: baseModel.reason };
      workflow.warning(`the model could not be compared with the base: ${baseModel.reason}`);
    } else {
      const before = baseModel.state === "found" ? baseModel.document : null;
      base = before ? { state: "compared" } : { state: "new" };
      diff = diffModels(before?.model ?? { nodes: [], edges: [], topology: "derived" }, model);
      const baseFiles = before ? emitTerraform(before.model, before.cloud, "terraform").files : [];
      const baseContent = new Map(baseFiles.map((f) => [f.name, f.content]));
      terraformChanged = terraform.files.filter((f) => baseContent.get(f.name) !== f.content).map((f) => f.name);
      for (const name of baseContent.keys()) if (!terraform.files.some((f) => f.name === name)) terraformChanged.push(name);
    }
  }

  const report = renderReport({
    mode: inputs.mode,
    modelPath: inputs.model,
    terraformDir: inputs.terraformDir,
    cloud,
    base,
    diff,
    diagram: diff ? renderDiagram(diff) : { mermaid: null, scope: "none" },
    warnings,
    terraformChanged,
    files,
    written,
    contentHash: receipt.contentHash,
    signed: receipt.signed,
  });
  workflow.summary(report);

  const changed = inputs.mode === "check" ? drifted.length > 0 : written.length > 0;
  workflow.setOutput("changed", String(changed));
  workflow.setOutput("receipt-path", receiptPath);
  workflow.setOutput("content-hash", receipt.contentHash);
  workflow.log(`receipt ${receipt.contentHash} (${receipt.signed ? "signed" : "unsigned"}) written to ${receiptPath}`);

  if (inputs.mode === "write") {
    workflow.log(written.length > 0 ? `wrote ${written.length} file(s) to ${inputs.terraformDir}: ${written.join(", ")}` : `${inputs.terraformDir} already matches the model`);
  }

  if (inputs.comment && pr) {
    await postComment(host, workflow, inputs.githubToken, pr.number, commentBody(report));
  }

  // A failed upload fails the step, but after the drift check below has had its say: both are reported.
  let uploadFailed = false;
  if (inputs.controlPlaneUrl) {
    // An allow-list: only a push to the default branch is the approval of a model. Other events
    // (a pull request, a workflow_run that checked out a fork's head, an issue comment, a schedule)
    // and pushes to other branches or tags can run with a model nobody has merged, and the run
    // token would still carry the repository's identity.
    const skipped =
      eventName !== UPLOAD_EVENT
        ? eventName === "pull_request"
          ? "the bundle was not uploaded: a pull request's model is not approved yet. Upload from a push to the default branch."
          : `the bundle was not uploaded: it is uploaded only from a push, and this run was triggered by ${JSON.stringify(eventName)}. Upload from a push to the default branch.`
        : pushSkipReason(host);
    if (skipped) {
      workflow.notice(skipped);
    } else {
      try {
        const sent = await uploadBundle(
          {
            url: inputs.controlPlaneUrl,
            audience: inputs.controlPlaneAudience,
            modelPath: relative(root, modelPath).split(sep).join("/"),
            sha: host.env.GITHUB_SHA,
            files: bundleFiles,
          },
          { host, workflow },
        );
        workflow.setOutput("snapshot-id", sent.snapshotId);
        workflow.log(`${sent.replayed ? "the control plane already had this bundle" : "uploaded the bundle"}: snapshot ${sent.snapshotId}`);
      } catch (error) {
        uploadFailed = true;
        workflow.error(error instanceof ActionError ? error.message : `upload failed: ${(error as Error).message}`);
      }
    }
  }

  if (inputs.mode === "check" && drifted.length > 0) {
    for (const file of drifted) {
      const shown = `${inputs.terraformDir.replace(/\/+$/, "")}/${file.name}`;
      workflow.group(`${shown} ${file.status === "missing" ? "is missing" : "differs from the model"}`, file.diff.split("\n"));
      workflow.error(`${shown} ${file.status === "missing" ? "is missing" : "does not match"} ${inputs.model}. Regenerate it (mode: write) and commit the result.`, shown);
    }
    return 1;
  }
  if (uploadFailed) return 1;
  workflow.log(inputs.mode === "check" ? `${inputs.terraformDir} matches ${inputs.model}` : "done");
  return 0;
}

async function postComment(host: Host, workflow: Workflow, token: string | undefined, issueNumber: number, body: string): Promise<void> {
  const repository = host.env.GITHUB_REPOSITORY ?? "";
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    workflow.warning("the pull-request comment was skipped: no github-token, or GITHUB_REPOSITORY is not set");
    return;
  }
  const target: CommentTarget = {
    fetch: host.fetch,
    apiUrl: host.env.GITHUB_API_URL || "https://api.github.com",
    token,
    repository,
    issueNumber,
  };
  try {
    const result = await upsertStickyComment(target, body);
    workflow.log(`${result.action} the pull-request comment`);
  } catch (error) {
    // A comment is a courtesy: a fork's read-only token or a missing scope must not hide the check.
    const hint = error instanceof GitHubApiError && (error.status === 403 || error.status === 404) ? " (the job needs pull-requests: write, and a fork's pull request has a read-only token)" : "";
    workflow.warning(`the pull-request comment could not be posted: ${(error as Error).message}${hint}`);
  }
}
