// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeFromPrompt } from "../src/features/workspace/engine.ts";
import { block, mapExpression, quote, renderDocument } from "../src/features/workspace/hcl.ts";
import { CLOUDS, type Cloud } from "../src/features/workspace/model.ts";
import { emitTerraform } from "../src/features/workspace/terraform.ts";
import { templateModel, WORKSPACE_TEMPLATES } from "../src/features/workspace/templates.ts";

/**
 * The emitter writes HCL a person reads, reviews and commits, so `terraform fmt`
 * finding something to change is a defect. `scripts/validate-emit.ts` proves it
 * against the real binary; these pin the two rules that were wrong — both of
 * which every generated document carried — without needing Terraform installed.
 */

describe("canonical formatting", () => {
  it("indents a map body under its key, not level with it", () => {
    const doc = renderDocument([
      block("resource", ["aws_instance", "web"], [
        { key: "ami", value: "var.web_ami" },
        { key: "instance_type", value: quote("t3.medium") },
        {
          key: "tags",
          value: mapExpression([
            { key: "Name", value: quote("web") },
            { key: "ManagedBy", value: quote("terragram") },
          ]),
        },
      ]),
    ]);
    assert.match(doc, /\n {4}Name {6}= "web"\n/, "map body sits two levels in");
    assert.match(doc, /\n {2}\}\n/, "the map's closing brace returns to the key's level");
  });

  it("ends an alignment run at a multi-line value, the way fmt does", () => {
    const doc = renderDocument([
      block("resource", ["aws_instance", "web"], [
        { key: "ami", value: "var.web_ami" },
        { key: "instance_type", value: quote("t3.medium") },
        { key: "tags", value: mapExpression([{ key: "Name", value: quote("web") }]) },
        { key: "depends_on", value: "[module.postgres]" },
      ]),
    ]);
    // `ami` pads to `instance_type`; `tags` and `depends_on` each take none.
    assert.match(doc, /\n {2}ami {11}= var\.web_ami\n/);
    assert.match(doc, /\n {2}instance_type = "t3\.medium"\n/);
    assert.match(doc, /\n {2}tags = \{\n/);
    assert.match(doc, /\n {2}depends_on = \[module\.postgres\]\n/);
  });

  it("indents required_providers' nested map under the provider key", () => {
    const { model } = composeFromPrompt("A web app");
    const main = emitTerraform(model, "aws").files[0]?.content ?? "";
    assert.match(main, /\n {4}aws = \{\n {6}source {2}= "hashicorp\/aws"\n {6}version = /);
  });
});

/**
 * A cheap structural stand-in for `terraform fmt -check` over every document the
 * product can produce: no line may be indented by an odd number of spaces, and no
 * attribute may be padded past the longest key in its own run.
 */
function formattingProblems(content: string): string[] {
  const problems: string[] = [];
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead % 2 !== 0) problems.push(`line ${index + 1}: odd indent (${lead}) — ${line.trim()}`);
    if (/^\s+\S+\s{2,}= .*\{$/.test(line) || /^\s+\S+\s{2,}= \[[^\]]*$/.test(line)) {
      problems.push(`line ${index + 1}: multi-line value padded as if aligned — ${line.trim()}`);
    }
  }
  return problems;
}

describe("every emitted document", () => {
  const cases: Array<{ label: string; cloud: Cloud; content: string }> = [];
  for (const template of WORKSPACE_TEMPLATES) {
    for (const cloud of CLOUDS) {
      for (const file of emitTerraform(templateModel(template), cloud as Cloud).files) {
        cases.push({ label: `${template.id}/${file.name}`, cloud: cloud as Cloud, content: file.content });
      }
    }
  }

  for (const item of cases) {
    it(`is canonically formatted: ${item.cloud} ${item.label}`, () => {
      assert.deepEqual(formattingProblems(item.content), []);
    });
  }
});
