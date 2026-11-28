// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { type GraphView, parseGraphDocument, projectGraph, renderGraphDrawio } from "terragram-engine/graph";

/**
 * The draw.io export of the Graph renderer: uncompressed `mxfile` XML that diagrams.net
 * opens, with the SVG's positions. The goldens are in tests/fixtures/graph/golden, and
 * tests/graph.test.ts holds the ones drawn from the shared estates.
 */

const fixture = (name: string) => new URL(`./fixtures/graph/${name}`, import.meta.url);

function golden(name: string, actual: string): void {
  const path = fixture(`golden/${name}`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path.pathname), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `${name} differs from its golden; UPDATE_GOLDEN=1 rewrites it`);
}

/** A group, two cards and one reference, written out so that the golden does not depend on the projection. */
const tiny: GraphView = {
  schema: "diagram.graph-view/v2",
  cloud: "aws",
  mode: "full",
  level: "detailed",
  compared: false,
  groups: [{ id: "g0", kind: "scope", label: "AWS account 123456789012", parent: null, status: "unchanged", findings: null }],
  nodes: [
    { id: "n0", group: "g0", type: "aws_vpc", label: "vpc-0a1b2c3d", service: "aws.network", category: "network", status: "unchanged", findings: null },
    { id: "n1", group: "g0", type: "aws_subnet", label: "subnet-0f1e2d3c", service: "aws.network", category: "network", status: "unchanged", findings: null },
  ],
  edges: [{ from: "n1", to: "n0", status: "unchanged", count: 1 }],
  hidden: { count: 0, types: [] },
};

const cells = (xml: string) =>
  [...xml.matchAll(/<mxCell ([^>]*?)\/?>/g)].map((m) => Object.fromEntries([...(m[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
const decode = (value: string) =>
  value.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

describe("renderGraphDrawio", () => {
  it("draws a group, two cards and an edge as a diagrams.net file", () => {
    const xml = renderGraphDrawio(tiny);
    golden("tiny.drawio", xml);

    const found = cells(xml);
    assert.deepEqual(
      found.map((c) => c.id),
      ["0", "1", "g0", "n0", "n1", "e0"],
    );
    assert.equal(found[0]?.parent, undefined);
    assert.equal(found[1]?.parent, "0");
    const byId = new Map(found.map((c) => [c.id, c]));
    assert.equal(byId.get("g0")?.parent, "1");
    assert.equal(byId.get("g0")?.vertex, "1");
    assert.match(byId.get("g0")?.style ?? "", /container=1/);
    for (const id of ["n0", "n1"]) assert.equal(byId.get(id)?.parent, "g0");
    assert.equal(byId.get("e0")?.edge, "1");
    assert.equal(byId.get("e0")?.source, "n1");
    assert.equal(byId.get("e0")?.target, "n0");
    assert.match(xml, /<mxCell id="e0"[^>]*><mxGeometry relative="1" as="geometry">/);
    assert.ok(xml.startsWith("<mxfile>\n"));
    assert.ok(xml.endsWith("</mxfile>\n"));
  });

  it("puts a card at a position relative to its container, clear of the heading", () => {
    const xml = renderGraphDrawio(tiny);
    const box = (id: string) => {
      const m = new RegExp(`id="${id}"[^>]*><mxGeometry x="(-?\\d+)" y="(-?\\d+)" width="(\\d+)" height="(\\d+)"`).exec(xml);
      return m?.slice(1).map(Number) as [number, number, number, number];
    };
    const [nx, ny, nw, nh] = box("n0");
    assert.deepEqual([nw, nh], [224, 62]);
    // The container is padded 14 around its cards and has 22 for its heading above them.
    assert.ok(nx >= 14 && ny >= 36, `card at ${nx},${ny}`);
  });

  it("gives the same bytes for the same view, and every reference lands on a cell", () => {
    assert.equal(renderGraphDrawio(tiny), renderGraphDrawio(structuredClone(tiny)));
    const doc = parseGraphDocument(readFileSync(fixture("medium.json"), "utf8"));
    const xml = renderGraphDrawio(projectGraph(doc, { title: "estate" }));
    const found = cells(xml);
    const ids = found.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    for (const c of found) {
      for (const ref of [c.parent, c.source, c.target]) if (ref !== undefined) assert.ok(ids.includes(ref), `${c.id} refers to ${ref}`);
    }
    assert.ok(found.some((c) => c.edge === "1"));
  });

  it("writes hostile text as text: markup, quotes, entities and control characters stay inert", () => {
    const evil = `</mxCell><mxCell id="x" vertex="1"/> <b>"a" & 'b' &amp; &#10;\u0007\u0000\ud800`;
    const view: GraphView = {
      ...tiny,
      title: evil,
      groups: [{ ...(tiny.groups[0] as GraphView["groups"][number]), label: evil, detail: evil }],
      nodes: [{ ...(tiny.nodes[0] as GraphView["nodes"][number]), type: evil, label: evil }, tiny.nodes[1] as GraphView["nodes"][number]],
    };
    const xml = renderGraphDrawio(view);
    golden("escaped.drawio", xml);

    // Nothing of it is markup: the only elements are the ones the exporter writes.
    assert.ok(!xml.includes('id="x"'));
    assert.ok(!xml.includes("<b>"));
    assert.equal(xml.match(/<mxCell /g)?.length, 7);
    assert.ok([...xml].every((ch) => ch === "\n" || (ch >= " " && !(ch >= "\ud800" && ch <= "\udfff"))), "no control character or lone surrogate");
    for (const value of xml.matchAll(/="([^"]*)"/g)) {
      assert.ok(!(value[1] as string).includes("<"), "no raw < inside an attribute");
      assert.ok(!/&(?!(amp|lt|gt|quot|apos|#10);)/.test(value[1] as string), `a bare & in ${value[1]}`);
    }
    const clean = [...evil].filter((ch) => ch >= " " && ch !== "\ud800").join("");
    const group = cells(xml).find((c) => c.id === "g0");
    assert.equal(decode(group?.value ?? ""), `${clean} ${clean}`);
    assert.equal(decode(/<diagram [^>]*name="([^"]*)"/.exec(xml)?.[1] ?? ""), clean);
  });

  it("draws an empty graph as a file that opens with its message", () => {
    const view: GraphView = { ...tiny, groups: [], nodes: [], edges: [] };
    const xml = renderGraphDrawio(view);
    golden("empty.drawio", xml);
    assert.deepEqual(
      cells(xml).map((c) => c.id),
      ["0", "1", "empty"],
    );
    assert.match(xml, /value="No resources to draw\."/);
    assert.match(renderGraphDrawio({ ...view, mode: "delta" }), /value="No changes\."/);
  });

  it("carries draw.io's own shape name for a service it has one for, and no art", () => {
    const doc = (cloud: "aws" | "azure" | "google", nodes: object[]) =>
      parseGraphDocument(
        JSON.stringify({
          schema: "infraharvest/graph/v1",
          run_id: "6f1c9d3e-0a52-5b8e-9c47-2d1f3a5b7c90",
          generated_at: "2026-11-20T10:00:00Z",
          tool: { name: "infraharvest", version: "0.4.0" },
          cloud,
          nodes,
          edges: [],
          redaction: { ids_hashed: false, hash_alg: "hmac-sha256" },
        }),
      );
    const aws = renderGraphDrawio(
      projectGraph(
        doc("aws", [
          { kind: "resource", type: "aws_lambda_function", id: "fn", account: "1" },
          { kind: "resource", type: "aws_db_instance", id: "db", account: "1" },
          { kind: "resource", type: "aws_accessanalyzer_analyzer", id: "an", account: "1" },
        ]),
      ),
    );
    assert.match(aws, /style="[^"]*shape=mxgraph\.aws4\.resourceIcon;resIcon=mxgraph\.aws4\.lambda;"/);
    assert.match(aws, /resIcon=mxgraph\.aws4\.rds;/);
    const found = cells(aws);
    const icons = found.filter((c) => c.id?.endsWith("-icon"));
    assert.equal(icons.length, 2, "the analyzer has no draw.io shape and keeps the plain card");
    for (const icon of icons) assert.ok(found.some((c) => c.id === icon.parent), "an icon is inside its card");
    assert.match(aws, /<mxCell id="n\d+-icon" value="" style="[^"]*" vertex="1" parent="n\d+"><mxGeometry x="10" y="\d+" width="32" height="32" as="geometry"\/>/);
    assert.ok(!/html=|<image|data:|base64|<svg/.test(aws), "a name, never markup or art");

    const azure = renderGraphDrawio(projectGraph(doc("azure", [{ kind: "resource", type: "azurerm_mssql_server", id: "sql", account: "sub" }])));
    assert.match(azure, /style="image;aspect=fixed;image=img\/lib\/azure2\/databases\/SQL_Database\.svg;"/);
    const gcp = renderGraphDrawio(projectGraph(doc("google", [{ kind: "resource", type: "google_container_cluster", id: "gke", account: "p" }])));
    assert.match(gcp, /shape=mxgraph\.gcp3\.gke;"/);

    const none = renderGraphDrawio(projectGraph(doc("aws", [{ kind: "resource", type: "aws_lambda_function", id: "fn", account: "1" }]), { level: "overview" }));
    assert.ok(!none.includes("-icon"), "a summary card stands for no service");
    assert.match(none, /value="[^"]*lambda 1|value="[^"]*compute 1/, "it lists its counts instead");
    const services = renderGraphDrawio(
      projectGraph(
        doc("aws", [
          { kind: "resource", type: "aws_lambda_function", id: "a", account: "1" },
          { kind: "resource", type: "aws_lambda_function", id: "b", account: "1" },
        ]),
        { level: "services" },
      ),
    );
    assert.match(services, /value="aws_lambda_function&#10;Lambda ×2"/);
    assert.match(services, /resIcon=mxgraph\.aws4\.lambda;/);
  });
});
