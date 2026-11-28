// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";


/**
 * The Google Cloud sandbox workflow's destroy steps must get to run: a job that times out runs no more
 * steps, so the round-trip job's timeout has to exceed the sum of its steps' own, with room for setup,
 * and stay under GitHub's six hours for a hosted runner. And its token may be had by nothing that installs,
 * nothing of what the first job wrote is run before it is checked, and Terraform may install only what the
 * committed lock file names.
 */
const workflow = readFileSync(new URL("../.github/workflows/sandbox-google.yml", import.meta.url), "utf8");
const script = readFileSync(new URL("../scripts/sandbox-gcp.sh", import.meta.url), "utf8");
const cliConfig = readFileSync(new URL("../scripts/sandbox-gcp.tfrc", import.meta.url), "utf8");

/** The text of one job: from its key to the next job's, or the end. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("sandbox-google workflow", () => {
  it("lets the round-trip job's timeout outlast its steps' timeouts", () => {
    const text = job("round-trip");
    const jobTimeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(text)?.[1]);
    const steps = [...text.matchAll(/^ {8}timeout-minutes: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(steps.length > 10, "the steps have timeouts");
    const sum = steps.reduce((a, b) => a + b, 0);
    assert.ok(sum + 10 <= jobTimeout, `steps add up to ${sum} minutes, the job's timeout is ${jobTimeout}`);
    assert.ok(jobTimeout <= 360, `the job's timeout is ${jobTimeout}, over GitHub's 360`);
  });

  it("installs dependencies only in the job that has no id-token and no environment", () => {
    const plans = job("plans");
    const roundTrip = job("round-trip");
    assert.doesNotMatch(plans, /id-token|environment:/);
    assert.match(plans, /npm ci --ignore-scripts/);
    assert.match(roundTrip, /id-token: write/);
    assert.doesNotMatch(roundTrip, /\bnpm\b|\bnpx\b|\bpnpm\b|\byarn\b|setup-node|node /);
  });

  it("changes nothing in the project before the preflight has passed", () => {
    const text = job("round-trip");
    const preflight = text.indexOf("id: preflight");
    assert.notEqual(preflight, -1);
    for (const m of text.matchAll(/run: scripts\/sandbox-gcp\.sh (apply|destroy|sweep)/g)) assert.ok((m.index ?? 0) > preflight, m[0]);
    for (const m of text.matchAll(/^ {8}if: (always\(\).*)$/gm)) assert.match(m[1] ?? "", /steps\.preflight\.outcome == 'success'|^always\(\)$/, m[0]);
  });

  it("checks the first job's plans before the second job signs in or runs Terraform, and not for a sweep", () => {
    const text = job("round-trip");
    const download = text.indexOf("actions/download-artifact");
    const check = text.indexOf("run: scripts/sandbox-gcp.sh validate");
    assert.ok(download !== -1 && check > download, "the check follows the download");
    for (const later of ["hashicorp/setup-terraform", "google-github-actions/auth", "id: preflight", "sandbox-gcp.sh apply"]) {
      assert.ok(text.indexOf(later) > check, `${later} comes after the check`);
    }
    const step = text.slice(text.lastIndexOf("- name:", check), check);
    assert.match(step, /if: inputs\.plan != 'sweep'/);
    assert.doesNotMatch(step, /continue-on-error/);
    assert.match(job("plans"), /run: scripts\/sandbox-gcp\.sh validate/);
  });

  it("starts Terraform only from the committed lock file and CLI configuration, with no plugin cache", () => {
    const inits = [...script.matchAll(/^[^#\n]*\bterraform init\b.*$/gm)].map((m) => m[0]);
    assert.ok(inits.length >= 1);
    for (const init of inits) assert.match(init, /-lockfile=readonly/, init);
    for (const init of script.matchAll(/retry tf_init (.*)/g)) assert.match(init[1] ?? "", /"\$id"|network/, init[0]);
    assert.doesNotMatch(script, /export TF_PLUGIN_CACHE_DIR|TF_CLI_ARGS_init|-plugin-dir|-upgrade|-lockfile=false/);
    assert.match(script, /export TF_CLI_CONFIG_FILE=\$here\/sandbox-gcp\.tfrc/);
    assert.match(script, /unset "\$name"[^\n]*\^\(TF_\|TERRAFORM_\)/);
    assert.doesNotMatch(workflow, /TF_PLUGIN_CACHE_DIR|TF_CLI_CONFIG_FILE|TF_REATTACH_PROVIDERS/);
    const settings = cliConfig.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    assert.deepEqual(settings, ["disable_checkpoint = true"]);
  });
});
