// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addNode } from "terragram-engine/inspector";
import { EMPTY_MODEL } from "terragram-engine/model";
import { emitTerraform } from "terragram-engine/terraform";

/**
 * `var.labels` is merged over the plan's labels and set on every resource. Google Cloud refuses a label whose key
 * does not start with a lowercase letter, or whose key or value has anything but lowercase letters, digits,
 * hyphens and underscores, or is over 63 characters, and it does so at apply: the plan has to say so first.
 */

const added = addNode(EMPTY_MODEL, "object-storage");
assert.ok(added);
const variables = emitTerraform(added.model, "gcp").files.find((f) => f.name === "variables.tf")?.content ?? "";
const block = /variable "labels" \{[\s\S]*?\n\}/.exec(variables)?.[0] ?? "";

/** The two patterns of the validation, as JavaScript expressions: the key's, then the value's. */
function patterns(): [RegExp, RegExp] {
  const found = [...block.matchAll(/regex\("((?:[^"\\]|\\.)*)", (k|v)\)/g)];
  const key = found.find((m) => m[2] === "k")?.[1];
  const value = found.find((m) => m[2] === "v")?.[1];
  assert.ok(key !== undefined && value !== undefined, `the validation reads a key and a value:\n${block}`);
  return [new RegExp((key as string).replaceAll("\\\\", "\\")), new RegExp((value as string).replaceAll("\\\\", "\\"))];
}

describe("the labels variable", () => {
  it("has a validation over every key and value", () => {
    assert.match(block, /validation \{/);
    assert.match(block, /condition\s+= alltrue\(\[for k, v in var\.labels : /);
    assert.match(block, /error_message/);
  });

  it("accepts what Google Cloud accepts", () => {
    const [key, value] = patterns();
    for (const k of ["owner", "cost_centre", "a", "team-1", `a${"b".repeat(62)}`]) assert.ok(key.test(k), `key ${k}`);
    for (const v of ["", "platform", "1234", "a-b_c", "b".repeat(63)]) assert.ok(value.test(v), `value ${v}`);
  });

  it("refuses what it refuses at apply", () => {
    const [key, value] = patterns();
    for (const k of ["", "Owner", "1team", "-team", "_team", "team name", "team.name", "team/name", "équipe", `a${"b".repeat(63)}`, "a\nb"]) assert.ok(!key.test(k), `key ${JSON.stringify(k)}`);
    for (const v of ["Platform", "a b", "a.b", "a/b", "é", "b".repeat(64), "a\nb"]) assert.ok(!value.test(v), `value ${JSON.stringify(v)}`);
  });
});
