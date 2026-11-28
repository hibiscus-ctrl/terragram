// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addNode } from "terragram-engine/inspector";
import { EMPTY_MODEL, type InfraModel } from "terragram-engine/model";
import { emitTerraform } from "terragram-engine/terraform";
import { evalHcl } from "./helpers/hcl-eval.ts";

/**
 * A Google Cloud service account id is 6 to 30 characters, and the plan builds it from `name_prefix` and the
 * node's slug. Two nodes of one kind (`virtual-machine`, `virtual-machine-2`) must not end up with the same id
 * when the id is cut to fit, because the second apply fails with a 409.
 */

function modelOf(...kinds: string[]): InfraModel {
  let model = EMPTY_MODEL;
  for (const kind of kinds) {
    const added = addNode(model, kind);
    assert.ok(added, kind);
    model = added.model;
  }
  return model;
}

const file = (model: InfraModel, name: string) => emitTerraform(model, "gcp").files.find((f) => f.name === name)?.content ?? "";

/** The `account_id` expression of every service account in the plan, by Terraform name. */
function accountIds(main: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of main.matchAll(/resource "google_service_account" "([^"]+)" \{\n\s+account_id\s+= (.+)\n/g)) out.set(m[1] as string, m[2] as string);
  return out;
}

const resolve = (expression: string, prefix: string) => String(evalHcl(expression, { name_prefix: prefix }));
const ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

describe("service account ids", () => {
  const model = modelOf("virtual-machine", "virtual-machine", "kubernetes", "kubernetes", "containers", "containers", "functions", "functions");
  const accounts = accountIds(file(model, "main.tf"));

  it("are distinct for two nodes of one kind, whatever the prefix", () => {
    assert.ok(accounts.size >= 8, `found ${accounts.size} service accounts`);
    for (const prefix of ["infra-prod", "a", "ih-sbx-tg-d1a2b", "a-rather-long-prefix"]) {
      const ids = [...accounts.values()].map((e) => resolve(e, prefix));
      assert.equal(new Set(ids).size, ids.length, `${prefix}: ${ids.join(", ")}`);
    }
  });

  it("are valid Google Cloud ids and keep the prefix at the front when cut", () => {
    for (const prefix of ["infra-prod", "a-rather-long-prefix"]) {
      for (const expression of accounts.values()) {
        const id = resolve(expression, prefix);
        assert.match(id, ID, `${prefix}: ${id}`);
        assert.ok(id.length <= 30, id);
        assert.ok(id.startsWith(`sa-${prefix}`.slice(0, 23)), `${id} keeps the start of sa-${prefix}`);
      }
    }
  });

  it("are stable, and unchanged when they fit", () => {
    assert.equal(resolve(accounts.get("virtual_machine") as string, "a"), "sa-a-virtual-machine");
    const first = resolve(accounts.get("virtual_machine_2") as string, "infra-prod");
    assert.equal(first, resolve(accounts.get("virtual_machine_2") as string, "infra-prod"));
    assert.notEqual(first, resolve(accounts.get("virtual_machine") as string, "infra-prod"));
  });

  it("are distinct for a prefix that makes every slug overflow", () => {
    const ids = [...accounts.values()].map((e) => resolve(e, "a-rather-long-prefix"));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.length === 30), ids.join(", "));
  });
});

describe("the name_prefix variable", () => {
  const variables = file(modelOf("virtual-machine"), "variables.tf");
  const block = /variable "name_prefix" \{[\s\S]*?\n\}/.exec(variables)?.[0] ?? "";

  it("has a validation of its length and shape", () => {
    assert.match(block, /validation \{/);
    assert.match(block, /condition\s+= can\(regex\(/);
    assert.match(block, /error_message/);
  });

  it("accepts the default and refuses what no id can be made from", () => {
    const pattern = /regex\("((?:[^"\\]|\\.)*)", var\.name_prefix\)/.exec(block)?.[1];
    assert.ok(pattern, block);
    const re = new RegExp((pattern as string).replaceAll("\\\\", "\\"));
    for (const ok of ["infra-prod", "a", "ih-sbx-tg-d1a2b", "x1"]) assert.ok(re.test(ok), ok);
    for (const bad of ["", "Infra", "1abc", "a_b", "a-", "-a", "a".repeat(21), "a b"]) assert.ok(!re.test(bad), JSON.stringify(bad));
  });
});
