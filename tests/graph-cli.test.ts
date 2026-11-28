// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseGraphDocument, projectGraph, renderGraphDrawio, renderGraphMermaid, renderGraphSvg } from "terragram-engine/graph";

import { run } from "../packages/cli/src/cli.ts";
import type { Io } from "../packages/cli/src/io.ts";

/**
 * `terragram graph` is a front door onto the Graph renderer, so its output is the
 * renderer's output byte for byte; these run it in-process over the committed fixtures
 * and compare. tests/cli-bundle.test.ts runs the built file.
 */

const fixtures = new URL("./fixtures/graph/", import.meta.url).pathname;
const small = join(fixtures, "small.json");
const base = join(fixtures, "small-base.json");
const medium = join(fixtures, "medium.json");
const environments = join(fixtures, "environments.json");
const doc = (path: string) => parseGraphDocument(readFileSync(path, "utf8"));

const scratch = mkdtempSync(join(tmpdir(), "terragram-graph-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => void out.push(t), err: (t) => void err.push(t), cwd: scratch };
  const code = await run(args, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("terragram graph", () => {
  it("prints the SVG the renderer draws, by default", async () => {
    const result = await cli("graph", small);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${renderGraphSvg(projectGraph(doc(small)))}\n`);
  });

  it("prints a Mermaid flowchart, or the view as JSON", async () => {
    const mermaid = await cli("graph", medium, "--format", "mermaid", "--title", "estate");
    assert.equal(mermaid.stdout, renderGraphMermaid(projectGraph(doc(medium), { title: "estate" })));
    const json = await cli("graph", medium, "-f", "json");
    assert.deepEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(projectGraph(doc(medium)))));
  });

  it("writes a draw.io file, the one the renderer draws", async () => {
    const result = await cli("graph", small, "--format", "drawio", "--title", "estate", "-o", "out/small.drawio");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "wrote out/small.drawio\n");
    assert.equal(readFileSync(join(scratch, "out/small.drawio"), "utf8"), renderGraphDrawio(projectGraph(doc(small), { title: "estate" })));
    assert.equal((await cli("graph", small, "-f", "drawio")).stdout, renderGraphDrawio(projectGraph(doc(small))));
  });

  it("writes a file with -o", async () => {
    const result = await cli("graph", small, "-o", "out/small.svg");
    assert.equal(result.stdout, "wrote out/small.svg\n");
    assert.equal(readFileSync(join(scratch, "out/small.svg"), "utf8"), `${renderGraphSvg(projectGraph(doc(small)))}\n`);
  });

  it("compares with --base, and draws only the change with --delta", async () => {
    const full = await cli("graph", small, "--base", base, "--format", "json");
    assert.equal(JSON.parse(full.stdout).changes.nodesAdded, 1);
    const delta = await cli("graph", small, "--base", base, "--delta", "-f", "mermaid");
    assert.equal(delta.stdout, renderGraphMermaid(projectGraph(doc(small), { base: doc(base), delta: true })));
  });

  it("places a finding by the Terraform address the graph keeps, with no resolver, and boxes each environment", async () => {
    writeFileSync(
      join(scratch, "by-address.json"),
      JSON.stringify({ findings: [
        { severity: "high", title: "wildcard", resource: "aws_iam_role.web" },
        { severity: "low", title: "in every root", resource: "aws_instance.web" },
      ] }),
    );
    const result = await cli("graph", environments, "--findings", "by-address.json", "-f", "json");
    assert.equal(result.code, 0, result.stderr);
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.findings, { total: 2, unplaced: 1, bySeverity: { high: 1 } });
    assert.deepEqual(view.groups.filter((g: { kind: string }) => g.kind === "environment").map((g: { label: string }) => g.label), ["environment prod", "environment staging", "environment dev"]);
    const mermaid = await cli("graph", environments, "-f", "mermaid");
    assert.equal(mermaid.stdout, renderGraphMermaid(projectGraph(doc(environments))));
  });

  it("lays findings over the graph, from infraharvest's OCSF export or a findings list", async () => {
    writeFileSync(
      join(scratch, "findings.json"),
      JSON.stringify({ findings: [{ severity: "high", title: "wildcard", type: "aws_iam_role", id: "web-role" }] }),
    );
    const listed = await cli("graph", small, "--findings", "findings.json", "-f", "json");
    assert.deepEqual(JSON.parse(listed.stdout).findings, { total: 1, unplaced: 0, bySeverity: { high: 1 } });

    writeFileSync(
      join(scratch, "ocsf.json"),
      JSON.stringify({
        schema: "infraharvest/ocsf-findings/v1",
        events: [{ severity: "Medium", message: "m", finding_info: { title: "G5 scanners", types: [] }, cloud: { account: { uid: "123456789012" } } }],
      }),
    );
    const ocsf = await cli("graph", small, "--findings", "ocsf.json", "-f", "json");
    assert.equal(JSON.parse(ocsf.stdout).groups[0].findings.count, 1);
  });

  it("changes what counts as glue with --show-glue, --hide and --keep", async () => {
    const count = async (...flags: string[]) => JSON.parse((await cli("graph", medium, "-f", "json", ...flags)).stdout).hidden.count;
    assert.equal(await count(), 11);
    assert.equal(await count("--show-glue"), 0);
    assert.equal(await count("--keep", "aws_lambda_permission"), 10);
    assert.equal(await count("--hide", "aws_cloudwatch_*", "--hide", "aws_eip"), 14);
  });

  it("packs toward the --aspect asked for, in the SVG and the draw.io file", async () => {
    const options = { aspect: 3 };
    assert.equal((await cli("graph", medium, "--aspect", "3")).stdout, `${renderGraphSvg(projectGraph(doc(medium)), options)}\n`);
    assert.equal((await cli("graph", medium, "--aspect", "3", "-f", "drawio")).stdout, renderGraphDrawio(projectGraph(doc(medium)), options));
    assert.notEqual((await cli("graph", medium, "--aspect", "3")).stdout, (await cli("graph", medium)).stdout);
  });

  it("exits 2 on bad arguments", async () => {
    for (const args of [["graph"], ["graph", small, medium], ["graph", small, "--format", "png"], ["graph", small, "--delta"], ["graph", small, "--nope"], ["graph", small, "--aspect", "wide"], ["graph", small, "--aspect", ""], ["graph", small, "--aspect", "0.1"], ["graph", small, "--aspect", "9"]]) {
      const result = await cli(...args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, /^terragram: /);
    }
  });

  it("exits 1 and names the file when a document is missing or is not what it should be", async () => {
    assert.equal((await cli("graph", "missing.json")).code, 1);
    writeFileSync(join(scratch, "bad.json"), JSON.stringify({ schema: "infraharvest/graph/v1" }));
    const bad = await cli("graph", "bad.json");
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /bad\.json: not an infraharvest graph\/v1 document/);
    const badBase = await cli("graph", small, "--base", "bad.json");
    assert.match(badBase.stderr, /bad\.json: not an infraharvest/);
    writeFileSync(join(scratch, "worse.json"), JSON.stringify({ findings: [{ severity: "urgent" }] }));
    const badFindings = await cli("graph", small, "--findings", "worse.json");
    assert.equal(badFindings.code, 1);
    assert.match(badFindings.stderr, /worse\.json: not a findings document/);
  });

  it("shows its help, and is listed in the CLI's", async () => {
    const help = await cli("graph", "--help");
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: terragram graph <graph\.json>/);
    assert.match((await cli("--help")).stdout, /graph {5}an infraharvest graph\/v1 document/);
  });
});

describe("terragram graph --level and --focus", () => {
  it("draws the level asked for, the one the renderer draws", async () => {
    for (const level of ["services", "overview", "detailed"] as const) {
      const svg = await cli("graph", medium, "--level", level);
      assert.equal(svg.code, 0, svg.stderr);
      assert.equal(svg.stdout, `${renderGraphSvg(projectGraph(doc(medium), { level }))}\n`);
      const mermaid = await cli("graph", medium, "--level", level, "-f", "mermaid");
      assert.equal(mermaid.stdout, renderGraphMermaid(projectGraph(doc(medium), { level })));
    }
    const json = JSON.parse((await cli("graph", medium, "--level", "services", "-f", "json")).stdout);
    assert.equal(json.level, "services");
    assert.equal(json.schema, "diagram.graph-view/v2");
    assert.ok(json.nodes.some((n: { aggregate?: unknown }) => n.aggregate !== undefined));
    assert.equal(json.edges.some((e: { count: number }) => e.count > 1), true);
  });

  it("draws a node and what is near it, with --focus and --hops, at any level and with a comparison", async () => {
    const one = await cli("graph", medium, "--focus", "n25", "-f", "json");
    assert.equal(JSON.parse(one.stdout).focus.hops, 1);
    const two = await cli("graph", medium, "--focus", "n25", "--hops", "2", "-f", "json");
    assert.equal(JSON.parse(two.stdout).focus.hops, 2);
    assert.ok(JSON.parse(two.stdout).nodes.length > JSON.parse(one.stdout).nodes.length);
    const svg = await cli("graph", medium, "--focus", "n25", "--hops", "2");
    assert.equal(svg.stdout, `${renderGraphSvg(projectGraph(doc(medium), { focus: { node: "n25", hops: 2 } }))}\n`);
    const services = await cli("graph", medium, "--level", "services", "--focus", "a3", "-f", "drawio");
    assert.equal(services.stdout, renderGraphDrawio(projectGraph(doc(medium), { level: "services", focus: { node: "a3" } })));
    const delta = await cli("graph", small, "--base", base, "--delta", "--level", "overview", "--focus", "a0", "-f", "json");
    assert.equal(delta.code, 0, delta.stderr);
    assert.equal(JSON.parse(delta.stdout).mode, "delta");
    const byLabel = await cli("graph", medium, "--focus", "vpc-0a1b2c3d", "-f", "json");
    assert.equal(JSON.parse(byLabel.stdout).focus.node, "n25");
  });

  it("exits 2 on a level, a focus or a hop count it cannot use", async () => {
    for (const args of [
      ["--level", "all"],
      ["--level", ""],
      ["--hops", "2"],
      ["--focus", ""],
      ["--focus", "n25", "--hops", "0"],
      ["--focus", "n25", "--hops", "4"],
      ["--focus", "n25", "--hops", "1.5"],
      ["--focus", "n25", "--hops", "two"],
      ["--focus", "n9999"],
      ["--level", "overview", "--focus", "n25"],
    ]) {
      const result = await cli("graph", medium, ...args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, /^terragram: /);
    }
    assert.match((await cli("graph", medium, "--focus", "n9999")).stderr, /there is no node "n9999"/);
  });

  it("describes them in its help", async () => {
    const help = (await cli("graph", "--help")).stdout;
    assert.match(help, /--level <level>/);
    assert.match(help, /--focus <node>/);
    assert.match(help, /--hops <n>.*1 to 3/);
  });
});
