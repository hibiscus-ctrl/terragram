// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleModel } from "terragram-engine/engine";
import { emitTerraform } from "terragram-engine/terraform";
import { GCP_PLANS } from "../scripts/emit-plans.ts";
import { evalHcl } from "./helpers/hcl-eval.ts";
import { AdaptationError, adaptForSandbox, dropBlock, replaceOnce, SANDBOX_ADAPTATIONS } from "../scripts/lib/sandbox-gcp.ts";

/**
 * The sandbox workflow applies the emit gate's Google Cloud plans to a real project after changing them
 * (`scripts/lib/sandbox-gcp.ts`). These hold that each change finds what it expects, leaves what it should
 * not touch, and that the names the sweep finds a run's resources by are what the plans write.
 */

const generate = (id: string) => {
  const plan = GCP_PLANS.find((p) => p.id === id);
  assert.ok(plan, id);
  return emitTerraform(assembleModel(plan.kinds, undefined, true).model, "gcp", "terraform").files;
};
const text = (files: readonly { name: string; content: string }[], name: string) => files.find((f) => f.name === name)?.content ?? "";

describe("the sandbox's changes to the Google Cloud plans", () => {
  it("covers every plan, and says what it changes", () => {
    assert.deepEqual(Object.keys(SANDBOX_ADAPTATIONS).sort(), GCP_PLANS.map((p) => p.id).sort());
  });

  it("changes the plans that need it, and no other", () => {
    for (const plan of GCP_PLANS) {
      const generated = generate(plan.id);
      const adapted = adaptForSandbox(plan.id, generated);
      const changed = (SANDBOX_ADAPTATIONS[plan.id] ?? []).length > 0;
      assert.equal(JSON.stringify(adapted) !== JSON.stringify(generated), changed, plan.id);
    }
  });

  it("leaves out App Engine, and the protection of the databases, of the data plan", () => {
    const files = adaptForSandbox("gcp-data", generate("gcp-data"));
    const all = files.map((f) => f.content).join("\n");
    assert.doesNotMatch(all, /google_app_engine/);
    assert.doesNotMatch(all, /front_door_to_app_service/);
    assert.doesNotMatch(all, /deletion_protection(_enabled)?\s*=\s*true/);
    assert.doesNotMatch(all, /deletion_policy\s*=\s*"ABANDON"/);
    assert.match(text(files, "main.tf"), /default_url_redirect \{/);
    assert.match(text(files, "main.tf"), /resource "google_sql_database_instance" "postgres"/);
  });

  it("builds the platform plan in the project it is given", () => {
    const files = adaptForSandbox("gcp-platform", generate("gcp-platform"));
    const all = files.map((f) => f.content).join("\n");
    assert.doesNotMatch(all, /google_project\./);
    assert.doesNotMatch(all, /google_project_iam_audit_config/);
    assert.doesNotMatch(all, /variable "(billing_account|org_id)"/);
    assert.match(text(files, "main.tf"), /resource "google_container_cluster" "kubernetes"/);
    const services = text(files, "main.tf").split('resource "google_project_service" "enabled" {')[1] ?? "";
    assert.match(services.slice(0, services.indexOf("\n}\n")), /project\s+= var\.project_id/);
  });

  it("fails, rather than guesses, when a change finds nothing to change", () => {
    assert.throws(() => replaceOnce("a = 1\n", "b = 1", "b", "b"), AdaptationError);
    assert.throws(() => dropBlock('resource "x" "y" {\n}\n', "resource", ["x", "z"]), AdaptationError);
    assert.throws(() => adaptForSandbox("gcp-data", [{ name: "main.tf", content: "" }]), AdaptationError);
    assert.throws(() => adaptForSandbox("gcp-unknown", []), AdaptationError);
  });

  it("names everything so the sweep finds it, within Google Cloud's limits", () => {
    // The prefix scripts/sandbox-gcp.sh gives a plan, and a long project ID: a bucket's name has both.
    const prefix = "ih-sbx-tg-d1a2b";
    const project = "sandbox-project-24-chars";
    const accounts = new Map<string, string>();
    for (const plan of GCP_PLANS) {
      const main = adaptForSandbox(plan.id, generate(plan.id))
        .map((f) => f.content)
        .join("\n");
      for (const block of main.split(/\n(?=resource ")/)) {
        const type = /^resource "(google_[a-z0-9_]+)"/.exec(block)?.[1];
        const expression = /^ {2}(?:name|account_id)\s*=\s*(.+)$/m.exec(block)?.[1];
        if (type === undefined || expression === undefined) continue;
        if (!expression?.includes("name_prefix")) continue;
        const isAccount = type === "google_service_account";
        const value = (isAccount ? String(evalHcl(expression, { name_prefix: prefix })) : expression)
          .replaceAll("${var.name_prefix}", prefix)
          .replaceAll("${var.project_id}", project)
          .replace(/^"|"$/g, "");
        if (isAccount) {
          const id = value;
          assert.ok(id.length <= 30, `${id} is over 30 characters`);
          assert.ok(!accounts.has(`${plan.id}/${id}`), `${plan.id}: two service accounts are named ${id}`);
          accounts.set(`${plan.id}/${id}`, id);
          assert.ok(id.includes(prefix), `${id} keeps the sweep's prefix`);
        } else if (type === "google_storage_bucket") {
          assert.ok(value.length <= 63, `${value} is over 63 characters`);
          assert.ok(value.includes(prefix), `${value} has the sweep's prefix`);
        }
      }
    }
    assert.ok(accounts.size >= 8, "the service accounts were found");
  });
});
