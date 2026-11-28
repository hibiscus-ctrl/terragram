// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  type FocusOptions,
  type GraphCategory,
  type GraphDocument,
  type GraphFinding,
  type GraphLevel,
  GRAPH_LEVELS,
  graphLayoutSchema,
  GraphViewError,
  layoutGraphDocument,
  MAX_FOCUS_HOPS,
  parseGraphDocument,
  projectGraph,
  renderGraphDrawio,
  renderGraphMermaid,
  renderGraphSvg,
  type GraphView,
  type ViewAggregate,
  type ViewNode,
} from "terragram-engine/graph";

/**
 * The Overview and Services levels fold the resources of the detailed picture into cards that stand for several; a focus
 * keeps a node and what is near it. What these hold is conservation (no resource and no reference is lost or counted
 * twice), that a card says which resources it stands for, and that the comparison and the findings come through.
 */

const dir = new URL("./fixtures/graph/", import.meta.url);
const load = (name: string): GraphDocument => parseGraphDocument(readFileSync(new URL(`${name}.json`, dir), "utf8"));
const small = load("small");
const smallBase = load("small-base");
const medium = load("medium");
const large = load("large");
const environments = load("environments");
const environmentsBase = load("environments-base");

const aggregates = (v: GraphView): ViewNode[] => v.nodes.filter((n) => n.aggregate !== undefined);
const ids = (v: GraphView) => v.nodes.map((n) => n.id);

/** Every node of the detailed picture is in exactly one card, and every reference is a line or inside a card. */
function assertConserved(detailed: GraphView, folded: GraphView): void {
  const members = folded.nodes.flatMap((n) => n.aggregate?.ids ?? [n.id]);
  assert.deepEqual([...members].sort(), ids(detailed).sort(), "the cards stand for every node once");
  const lines = folded.edges.reduce((sum, e) => sum + e.count, 0);
  const inside = folded.nodes.reduce((sum, n) => sum + (n.aggregate?.internal ?? 0), 0);
  assert.equal(lines + inside, detailed.edges.reduce((sum, e) => sum + e.count, 0), "the lines and what is inside the cards add up to the references");
  for (const n of aggregates(folded)) {
    const a = n.aggregate as ViewAggregate;
    assert.equal(a.count, a.ids.length);
    const categories: Partial<Record<GraphCategory, number>> = a.byCategory;
    assert.equal(Object.values(categories).reduce((s, c) => s + c, 0), a.count);
    assert.equal(Object.values(a.byStatus).reduce((s, c) => s + c, 0), a.count);
    assert.equal(a.types.reduce((s, t) => s + t.count, 0), a.count);
  }
  const boxes = new Set(folded.groups.map((g) => g.id));
  for (const n of folded.nodes) assert.ok(boxes.has(n.group), `${n.id} is in a box that exists`);
  for (const g of folded.groups) assert.ok(g.parent === null || boxes.has(g.parent));
}

describe("level: detailed", () => {
  it("is today's picture, and the default", () => {
    const view = projectGraph(medium);
    assert.equal(view.level, "detailed");
    assert.deepEqual(projectGraph(medium, { level: "detailed" }), view);
    assert.equal(view.schema, "diagram.graph-view/v2");
    assert.equal(aggregates(view).length, 0);
    assert.ok(view.edges.every((e) => e.count === 1));
    assert.ok(view.nodes.every((n) => /^n\d+$/.test(n.id) && n.service.length > 0));
  });

  it("gives each node its service, and takes its category from it", () => {
    const view = projectGraph(medium);
    const rds = view.nodes.find((n) => n.type === "aws_db_instance");
    assert.equal(rds?.service, "aws.rds");
    assert.equal(rds?.category, "data");
    assert.equal(view.nodes.find((n) => n.type === "module call")?.service, "terraform.module");
  });

  it("refuses a level it does not know", () => {
    assert.throws(() => projectGraph(medium, { level: "nope" as GraphLevel }), GraphViewError);
  });
});

describe("level: services", () => {
  const detailed = projectGraph(medium);
  const view = projectGraph(medium, { level: "services" });

  it("merges the resources of one service in a box into one card, 'Lambda ×2', and keeps a service of one", () => {
    assertConserved(detailed, view);
    const lambda = view.nodes.find((n) => n.service === "aws.lambda");
    assert.equal(lambda?.label, "Lambda ×2");
    assert.equal(lambda?.type, "aws_lambda_function");
    assert.equal(lambda?.aggregate?.count, 2);
    assert.equal(lambda?.category, "compute");
    assert.match(lambda?.id ?? "", /^a\d+$/);
    // The ids it stands for are the detailed picture's, so a viewer can expand it.
    for (const id of lambda?.aggregate?.ids ?? []) assert.equal(detailed.nodes.find((n) => n.id === id)?.service, "aws.lambda");
    // aws_dynamodb_table is alone in its box: it keeps its own card and id.
    const table = view.nodes.find((n) => n.type === "aws_dynamodb_table");
    assert.equal(table?.aggregate, undefined);
    assert.equal(table?.id, detailed.nodes.find((n) => n.type === "aws_dynamodb_table")?.id);
  });

  it("does not merge across boxes, and says what types a card holds", () => {
    const subnets = view.nodes.filter((n) => n.service === "aws.vpc");
    assert.equal(subnets.length, 2, "the vpc module of each account has its own");
    const big = subnets.find((n) => (n.aggregate?.count ?? 0) > 3);
    assert.ok(big);
    assert.deepEqual(big?.aggregate?.types.map((t) => t.type), ["aws_subnet", "aws_route_table", "aws_eip", "aws_internet_gateway", "aws_nat_gateway", "aws_vpc"]);
    assert.equal(big?.type, "aws_subnet", "the type most of them have");
    assert.equal(big?.label, "VPC ×10");
  });

  it("adds the references up: a line says how many it stands for", () => {
    assert.ok(view.edges.length < detailed.edges.length);
    assert.ok(view.edges.some((e) => e.count > 1));
    assert.equal(new Set(view.edges.map((e) => `${e.from}>${e.to}`)).size, view.edges.length, "one line per pair");
  });

  it("is the same picture from a document that lists its nodes in another order", () => {
    const reversed: GraphDocument = {
      ...medium,
      nodes: [...medium.nodes].reverse().map((n) => (n.parent === undefined ? n : { ...n, parent: medium.nodes.length - 1 - n.parent })),
      edges: medium.edges.map((e) => ({ from: medium.nodes.length - 1 - e.from, to: medium.nodes.length - 1 - e.to })).reverse(),
    };
    assert.deepEqual(projectGraph(reversed, { level: "services" }), view);
  });
});

describe("level: overview", () => {
  const detailed = projectGraph(medium);
  const view = projectGraph(medium, { level: "overview" });

  it("turns each box that has no box in it into one summary card, and leaves the scopes as boxes", () => {
    assertConserved(detailed, view);
    assert.deepEqual(view.groups.map((g) => [g.kind, g.parent]), [["scope", null], ["scope", null]]);
    assert.equal(view.nodes.length, 5, "three module boxes and what is directly in each of the two accounts");
    const modules = view.nodes.filter((n) => n.type === "module");
    assert.deepEqual(modules.map((n) => n.label), ["s3-bucket/aws 4.1.0", "vpc/aws 5.13.0", "vpc/aws 5.13.0"]);
    assert.ok(view.nodes.every((n) => n.service === "terraform.group" && n.category === "other"));
    assert.ok(view.nodes.every((n) => n.aggregate?.level === "overview"));
  });

  it("counts a card's resources by category and as a whole", () => {
    const vpc = view.nodes.find((n) => n.label.startsWith("vpc/aws") && n.aggregate?.count === 11);
    assert.ok(vpc, "the first account's vpc module has 11 nodes, its module card among them");
    assert.deepEqual(vpc?.aggregate?.byCategory, { network: 10, other: 1 });
    const loose = view.nodes.find((n) => n.type === "resources");
    assert.equal(loose?.label, "not in a module");
    assert.equal(loose?.aggregate?.count, 12);
  });

  it("adds the references between groups up, and keeps the ones inside a group out of the lines", () => {
    assert.ok(view.edges.length > 0 && view.edges.length < 10);
    assert.ok(view.nodes.every((n) => (n.aggregate?.internal ?? 0) >= 0));
    assert.ok(view.nodes.some((n) => (n.aggregate?.internal ?? 0) > 0));
  });

  it("keeps a box that has boxes inside it, with the resources directly in it as a card", () => {
    const folded = projectGraph(environments, { level: "overview" });
    assertConserved(projectGraph(environments), folded);
    assert.deepEqual(folded.groups.map((g) => g.kind), ["scope", "scope", "environment"]);
    assert.deepEqual(folded.nodes.map((n) => n.label), ["not in an environment", "not in a module", "staging", "dev", "vpc/aws 5.13.0"]);
    assert.deepEqual(folded.nodes.map((n) => n.type), ["resources", "resources", "environment", "environment", "module"]);
  });

  it("holds an estate larger than the cut whole, where the detailed picture is cut", () => {
    const many = {
      ...medium,
      nodes: Array.from({ length: 30 }, (_, i) => ({ kind: "resource" as const, type: "aws_instance", id: `i-${i}`, account: "123456789012" })),
      edges: [],
    };
    const cut = projectGraph(many, { maxNodes: 10 });
    assert.equal(cut.cut?.nodes, 20);
    const overview = projectGraph(many, { maxNodes: 10, level: "overview" });
    assert.equal(overview.cut, undefined);
    assert.equal(overview.nodes[0]?.aggregate?.count, 30);
  });
});

describe("level with a comparison", () => {
  it("says changed for a card whose resources changed differently, and counts each in byStatus", () => {
    const view = projectGraph(small, { base: smallBase, level: "services" });
    assert.equal(view.compared, true);
    const ec2 = view.nodes.find((n) => n.service === "aws.ec2");
    assert.equal(ec2?.status, "changed");
    assert.deepEqual(ec2?.aggregate?.byStatus, { unchanged: 1, removed: 1 });
    assert.equal(view.nodes.find((n) => n.type === "aws_security_group")?.status, "added", "a service of one keeps its status");
    assert.deepEqual(view.changes, projectGraph(small, { base: smallBase }).changes, "the counts of the change are the document's");
  });

  it("gives a card of resources that all changed the same way that status", () => {
    const view = projectGraph(small, { base: smallBase, level: "overview" });
    const vpc = view.nodes.find((n) => n.label.startsWith("vpc/aws"));
    assert.equal(vpc?.status, "changed", "its module version changed");
    assert.ok(vpc?.label.endsWith("5.13.0"), "and its version is named");
  });

  it("draws a line that stands for references that changed differently as changed", () => {
    const base = parseGraphDocument(JSON.stringify(refs(2)));
    const head = parseGraphDocument(JSON.stringify(refs(3)));
    const view = projectGraph(head, { base, level: "services" });
    const line = view.edges.find((e) => e.count === 3);
    assert.equal(line?.status, "changed");
    assert.equal(projectGraph(head, { base, level: "detailed" }).edges.filter((e) => e.status === "added").length, 1);
    assert.match(renderGraphSvg(view), /marker id="tg-arrow-changed"/);
    assert.match(renderGraphMermaid(view), /==>\|"×3"\|/);
    assert.match(renderGraphDrawio(view), /value="×3"/);
  });

  it("draws only what changed, and what is one reference away, at every level", () => {
    const detailed = projectGraph(small, { base: smallBase, delta: true });
    for (const level of GRAPH_LEVELS) {
      const view = projectGraph(small, { base: smallBase, delta: true, level });
      assert.equal(view.mode, "delta");
      assert.equal(view.level, level);
      assertConserved(detailed, view);
      assert.ok(view.nodes.length >= 1);
    }
    const overview = projectGraph(small, { base: smallBase, delta: true, level: "overview" });
    assert.ok(overview.nodes.some((n) => n.status === "context" || n.status === "changed"));
  });

  it("keeps the findings a card's resources had, and a box's own", () => {
    const findings: GraphFinding[] = [
      { severity: "high", title: "open", type: "aws_instance", id: "i-0abc123def456" },
      { severity: "low", title: "tag", type: "aws_iam_role", id: "web-role" },
      { severity: "medium", title: "account", account: "123456789012" },
    ];
    const detailed = projectGraph(small, { findings });
    const total = (v: GraphView) => v.nodes.reduce((s, n) => s + (n.findings?.count ?? 0), 0) + v.groups.reduce((s, g) => s + (g.findings?.count ?? 0), 0);
    for (const level of GRAPH_LEVELS) assert.equal(total(projectGraph(small, { findings, level })), total(detailed), level);
    const services = projectGraph(small, { findings, level: "services" });
    assert.deepEqual(services.nodes.find((n) => n.service === "aws.iam")?.findings, { count: 1, worst: "low", bySeverity: { low: 1 } });
    assert.equal(services.findings?.total, 3);
    const overview = projectGraph(small, { findings, level: "overview" });
    assert.equal(overview.nodes.find((n) => n.type === "resources")?.findings?.worst, "high");
  });
});

/** One account with `n` instances that refer to one security group. */
function refs(n: number): unknown {
  const nodes: unknown[] = Array.from({ length: n }, (_, i) => ({ kind: "resource", type: "aws_instance", id: `i-${i}`, account: "123456789012" }));
  nodes.push({ kind: "resource", type: "aws_security_group", id: "sg-1", account: "123456789012" });
  return {
    schema: "infraharvest/graph/v1",
    run_id: "6f1c9d3e-0a52-5b8e-9c47-2d1f3a5b7c90",
    generated_at: "2026-11-20T10:00:00Z",
    tool: { name: "infraharvest", version: "0.4.0" },
    cloud: "aws",
    nodes,
    edges: Array.from({ length: n }, (_, i) => ({ from: i, to: n })),
    redaction: { ids_hashed: false, hash_alg: "hmac-sha256" },
  };
}

describe("focus", () => {
  const detailed = projectGraph(large);
  const hub = detailed.nodes.find((n) => n.type === "aws_vpc" && n.label.startsWith("vpc-0a1b2c3d"));
  assert.ok(hub);

  it("keeps the node, what refers to it or is referred by it, and the boxes around them", () => {
    const focus: FocusOptions = { node: hub.id };
    const view = projectGraph(large, { focus });
    assert.deepEqual(view.focus, { node: hub.id, label: hub.label, hops: 1, shown: view.nodes.length, of: detailed.nodes.length });
    const near = new Set([hub.id, ...detailed.edges.flatMap((e) => (e.from === hub.id ? [e.to] : e.to === hub.id ? [e.from] : []))]);
    assert.deepEqual(new Set(ids(view)), near);
    assert.ok(view.edges.every((e) => near.has(e.from) && near.has(e.to)));
    assert.ok(view.groups.length < detailed.groups.length);
    const boxes = new Set(view.groups.map((g) => g.id));
    assert.ok(view.nodes.every((n) => boxes.has(n.group)));
  });

  it("keeps the ids the picture has without the focus, and reaches farther with more hops", () => {
    const one = projectGraph(large, { focus: { node: hub.id, hops: 1 } });
    const two = projectGraph(large, { focus: { node: hub.id, hops: 2 } });
    const three = projectGraph(large, { focus: { node: hub.id, hops: MAX_FOCUS_HOPS } });
    assert.ok(one.nodes.length < two.nodes.length && two.nodes.length <= three.nodes.length);
    for (const n of two.nodes) assert.deepEqual(n, detailed.nodes.find((d) => d.id === n.id));
    assert.deepEqual(projectGraph(large, { focus: { node: hub.id, hops: 1 } }), one, "hops default to 1");
    assert.deepEqual(projectGraph(large, { focus: { node: hub.id } }), one);
  });

  it("follows a reference in either direction, and stops at the ends of a chain", () => {
    const chain = projectGraph(large, { focus: { node: hub.id, hops: 3 } });
    assert.ok(chain.nodes.length < detailed.nodes.length, "the other account is not reached");
  });

  it("finds a node by a label only it has", () => {
    const view = projectGraph(large, { focus: { node: "vpc-0a1b2c3d" } });
    assert.equal(view.focus?.node, hub.id);
    assert.throws(() => projectGraph(large, { focus: { node: "aws_nope" } }), /there is no node "aws_nope"/);
    const twice = detailed.nodes.find((n) => detailed.nodes.filter((o) => o.label === n.label).length > 1);
    if (twice) assert.throws(() => projectGraph(large, { focus: { node: twice.label } }), GraphViewError);
  });

  it("refuses hops outside 1 to 3, and no node", () => {
    for (const hops of [0, 4, 1.5, Number.NaN]) assert.throws(() => projectGraph(large, { focus: { node: hub.id, hops } }), RangeError);
    assert.throws(() => projectGraph(large, { focus: { node: "" } }), GraphViewError);
  });

  it("works on a card of the Services or Overview level, with the ids of that level", () => {
    const services = projectGraph(large, { level: "services" });
    const lambda = services.nodes.find((n) => n.service === "aws.lambda");
    assert.ok(lambda);
    const view = projectGraph(large, { level: "services", focus: { node: lambda.id, hops: 2 } });
    assert.equal(view.level, "services");
    assert.equal(view.focus?.node, lambda.id);
    assert.ok(view.nodes.length < services.nodes.length);
    for (const n of view.nodes) assert.deepEqual(n, services.nodes.find((s) => s.id === n.id));
    const overview = projectGraph(large, { level: "overview" });
    const card = overview.nodes[0];
    assert.ok(card);
    assert.equal(projectGraph(large, { level: "overview", focus: { node: card.id } }).focus?.of, overview.nodes.length);
    assert.throws(() => projectGraph(large, { level: "overview", focus: { node: hub.id } }), /level overview/, "a detailed id is not a card of the Overview");
  });

  it("works with a delta: a node of the changes and what is near it", () => {
    const delta = projectGraph(small, { base: smallBase, delta: true });
    const added = delta.nodes.find((n) => n.status === "added");
    assert.ok(added);
    const view = projectGraph(small, { base: smallBase, delta: true, focus: { node: added.id } });
    assert.equal(view.mode, "delta");
    assert.ok(view.nodes.length <= delta.nodes.length);
    assert.equal(view.nodes.find((n) => n.id === added.id)?.status, "added");
    assert.deepEqual(view.changes, delta.changes);
    const unchanged = projectGraph(small, { base: smallBase }).nodes.find((n) => n.status === "unchanged" && n.type === "aws_iam_policy");
    if (unchanged && !delta.nodes.some((n) => n.id === unchanged.id)) {
      assert.throws(() => projectGraph(small, { base: smallBase, delta: true, focus: { node: unchanged.id } }), /delta/);
    }
  });

  it("is cut after it, so a focus on a big estate draws what is left in whole", () => {
    const view = projectGraph(large, { focus: { node: hub.id, hops: 2 }, maxNodes: 3 });
    assert.equal(view.nodes.length, 3);
    assert.ok(view.cut && view.cut.nodes > 0);
  });
});

describe("every level, with and without a comparison and a focus", () => {
  const cases: [string, GraphDocument, GraphDocument | undefined][] = [
    ["small", small, smallBase],
    ["environments", environments, environmentsBase],
    ["medium", medium, undefined],
  ];
  for (const [name, doc, base] of cases) {
    for (const level of GRAPH_LEVELS) {
      for (const delta of base ? [false, true] : [false]) {
        for (const focused of [false, true]) {
          it(`${name}, ${level}${delta ? ", delta" : ""}${focused ? ", focus" : ""}: a layout the schema accepts, and every format draws it`, () => {
            const options = { level, ...(base && { base }), delta };
            const whole = projectGraph(doc, options);
            const first = whole.nodes.find((n) => (n.aggregate?.count ?? 1) >= 1);
            if (first === undefined) return;
            const view = projectGraph(doc, { ...options, ...(focused && { focus: { node: first.id, hops: 2 } }) });
            const layout = layoutGraphDocument(doc, { ...options, ...(focused && { focus: { node: first.id, hops: 2 } }) });
            assert.equal(graphLayoutSchema.safeParse(layout).success, true);
            assert.deepEqual(layout.nodes.map((n) => n.id), ids(view));
            assert.equal(layout.level, level);
            assert.equal(layout.focus === null, !focused);
            const svg = renderGraphSvg(view);
            assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
            assert.ok(renderGraphDrawio(view).includes("<mxfile>"));
            assert.ok(renderGraphMermaid(view).startsWith("flowchart TB") || renderGraphMermaid(view).includes("flowchart TB"));
          });
        }
      }
    }
  }
});
