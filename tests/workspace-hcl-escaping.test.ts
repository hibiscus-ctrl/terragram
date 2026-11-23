// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { composeFromPrompt } from "terragram-engine/engine";
import { quote, quoteTemplate } from "terragram-engine/hcl";
import { addNode, setNodeAttribute } from "terragram-engine/inspector";
import { attributeProblems } from "terragram-engine/kinds";
import { type Cloud, EMPTY_MODEL, type InfraModel } from "terragram-engine/model";
import { emitTerraform, ModelAttributeError } from "terragram-engine/terraform";

import { parseModelDocument } from "../action/src/model-file.ts";
import { run } from "../packages/cli/src/cli.ts";
import type { Io } from "../packages/cli/src/io.ts";

/**
 * Text from a model file reaches the plan, so it must stay text. `${...}` and `%{...}` are
 * template syntax Terraform evaluates inside any quoted string, and a newline ends the
 * string. A pull request that edits `diagram.json` must not be able to turn a field into
 * an expression such as `${var.db_password}`.
 */

describe("quote", () => {
  it("writes template sequences as their escapes", () => {
    assert.equal(quote("${var.db_password}.example.org"), '"$${var.db_password}.example.org"');
    assert.equal(quote("%{ if true }x%{ endif }"), '"%%{ if true }x%%{ endif }"');
    // A literal `$${` in the text is escaped again, so it round-trips as written.
    assert.equal(quote("$${x}"), '"$$${x}"');
    assert.equal(quote("cost: $5 and 100%"), '"cost: $5 and 100%"');
  });

  it("keeps control characters from ending the string or the line", () => {
    assert.equal(quote("a\nb\rc\td"), '"a\\nb\\rc\\td"');
    assert.equal(quote("a\u0000b\u001fc\u007fd"), '"a\\u0000b\\u001fc\\u007fd"');
    assert.equal(quote("a b"), '"a\\u2028b"');
    assert.equal(quote('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
    assert.ok(!quote("x\ny").includes("\n"));
  });
});

describe("quoteTemplate", () => {
  it("keeps the generator's own references and escapes what is spliced in", () => {
    const slug = "${var.secret}";
    assert.equal(quoteTemplate`q-\${var.name_prefix}-${slug}`, '"q-${var.name_prefix}-$${var.secret}"');
    assert.equal(quoteTemplate`\${path.module}/src/${"a\nb"}`, '"${path.module}/src/a\\nb"');
  });
});

function withAttribute(kind: string, key: string, value: string): InfraModel {
  const added = addNode(EMPTY_MODEL, kind);
  assert.ok(added, `no ${kind} kind`);
  return setNodeAttribute(added.model, added.id, key, value);
}

const CLOUDS: Cloud[] = ["azure", "aws"];

describe("free-text attributes", () => {
  const badZones = [
    "${var.db_password}.example.org",
    "a%{ if true }b.example.org",
    "example.org\nresource",
    "a b.example.org",
    "",
    "-a.example.org",
    "single",
    "single.",
    "a..example.org",
    ".",
    "example.org..",
    ".example.org",
  ];
  for (const cloud of CLOUDS) {
    for (const value of badZones) {
      it(`refuses Zone name ${JSON.stringify(value)} on ${cloud}`, () => {
        const model = withAttribute("dns", "Zone name", value);
        assert.throws(
          () => emitTerraform(model, cloud),
          (error) => {
            assert.ok(error instanceof ModelAttributeError);
            assert.match(error.message, /Zone name .* is not a DNS name such as example\.gov\.uk/);
            return true;
          },
        );
      });
    }
  }

  it("explains why a single label is refused", () => {
    const [problem] = attributeProblems(withAttribute("dns", "Zone name", "internal").nodes);
    assert.match(problem ?? "", /one label.*Route 53 and Azure DNS.*top-level domains/);
  });

  for (const cloud of CLOUDS) {
    it(`emits a zone name written with its trailing dot, without the dot, on ${cloud}`, () => {
      const dotted = emitTerraform(withAttribute("dns", "Zone name", "My-Zone.example.gov.uk."), cloud);
      const plain = emitTerraform(withAttribute("dns", "Zone name", "My-Zone.example.gov.uk"), cloud);
      assert.equal(dotted.files[0]?.content, plain.files[0]?.content);
      assert.match(dotted.files[0]?.content ?? "", /"My-Zone\.example\.gov\.uk"/);
      assert.doesNotMatch(dotted.files[0]?.content ?? "", /gov\.uk\."/);
    });
  }

  it("keeps a trailing dot out of the custom domain a zone serves", () => {
    const { model } = composeFromPrompt("A website on a custom domain with DNS, a web app and a database");
    const dns = model.nodes.find((n) => n.kind === "dns");
    assert.ok(dns);
    const dotted = setNodeAttribute(model, dns.id, "Zone name", "example.gov.uk.");
    for (const cloud of CLOUDS) {
      const out = emitTerraform(dotted, cloud);
      const text = out.files.map((file) => file.content).join("\n");
      assert.match(text, /"www\.example\.gov\.uk"/, cloud);
      assert.doesNotMatch(text, /gov\.uk\.["\s]/, cloud);
    }
  });

  const badSpaces = [
    "${var.db_password}",
    "10.0.0.0/16,10.1.0.0/16",
    "10.0.0.0/33",
    "300.0.0.0/16",
    "10.0.0.0",
    "10.0.0.0/16\n",
    "fd00::/48",
    "",
  ];
  for (const cloud of CLOUDS) {
    for (const value of badSpaces) {
      it(`refuses Address space ${JSON.stringify(value)} on ${cloud}`, () => {
        const model = withAttribute("vnet", "Address space", value);
        assert.throws(
          () => emitTerraform(model, cloud),
          (error) => {
            assert.ok(error instanceof ModelAttributeError);
            assert.match(error.message, /Address space .* is not an IPv4 CIDR block such as 10\.0\.0\.0\/16/);
            return true;
          },
        );
      });
    }
  }

  it("still emits ordinary values, and the plan's own references", () => {
    const zone = emitTerraform(withAttribute("dns", "Zone name", "My-Zone.example.gov.uk"), "azure");
    assert.match(zone.files[0]?.content ?? "", /"My-Zone\.example\.gov\.uk"/);
    const net = emitTerraform(withAttribute("vnet", "Address space", "172.16.0.0/12"), "azure");
    const main = net.files[0]?.content ?? "";
    assert.match(main, /"172\.16\.0\.0\/12"/);
    assert.match(main, /"rg-\$\{var\.name_prefix\}"/);
    const planned = emitTerraform(composeFromPrompt("A web app with a Postgres database").model, "azure");
    assert.match(planned.files[0]?.content ?? "", /"vnet-\$\{var\.name_prefix\}"/);
    const queue = emitTerraform(addNode(EMPTY_MODEL, "queue")?.model ?? EMPTY_MODEL, "aws");
    assert.match(queue.files[0]?.content ?? "", /"q-\$\{var\.name_prefix\}-/);
  });

  it("names the node, the field and the value", () => {
    const model = withAttribute("dns", "Zone name", "${x}");
    const problems = attributeProblems(model.nodes);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /Zone name "\$\{x\}" is not a DNS name/);
    // A value is shown as JSON, so a newline in it cannot add a line to a log or a comment.
    const lined = attributeProblems(withAttribute("dns", "Zone name", "a\n::error::x").nodes);
    assert.equal(lined.join("").includes("\n"), false);
  });

  it("is checked when the Action reads the model file", () => {
    const model = withAttribute("dns", "Zone name", "${var.db_password}.example.org");
    const parsed = parseModelDocument(JSON.stringify({ schema: "diagram.model/v1", cloud: "aws", ...model }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.problem, /values that cannot be used[\s\S]*Zone name/);
  });
});

describe("terragram explain", () => {
  it("reports a value that cannot be used as a failed command, not an unexpected error", async () => {
    const model = withAttribute("dns", "Zone name", "${var.db_password}.example.org");
    const dir = mkdtempSync(join(tmpdir(), "terragram-escaping-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.json"), JSON.stringify({ schema: "diagram.model/v1", cloud: "aws", ...model }));
    const err: string[] = [];
    const io: Io = { out: () => undefined, err: (t) => void err.push(t), cwd: dir };
    const code = await run(["explain", "model.json"], io);
    assert.equal(code, 1);
    assert.match(err.join(""), /terragram: The model has values that cannot be used[\s\S]*Zone name/);
    assert.doesNotMatch(err.join(""), /unexpected error/);
  });
});
