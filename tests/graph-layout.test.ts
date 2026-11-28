// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  GRAPH_LAYOUT_SCHEMA,
  type GraphDocument,
  type GraphFinding,
  type GraphLayoutView,
  graphLayoutSchema,
  type LayoutEdge,
  type LayoutGroup,
  type LayoutNode,
  layoutGraphDocument,
  layoutGraphView,
  MAX_GRAPH_NODES,
  parseGraphDocument,
  projectGraph,
  renderGraphSvg,
} from "terragram-engine/graph";

/**
 * The layout is the picture as data: a viewer that places these rectangles draws what the SVG draws.
 * These tests check behaviour (where things are, what they point at, that it is stable, cut and clean),
 * not bytes; the SVG's bytes are the goldens' of graph.test.ts.
 */

const fixtureDir = new URL("./fixtures/graph/", import.meta.url);
const load = (name: string): GraphDocument => parseGraphDocument(readFileSync(new URL(`${name}.json`, fixtureDir), "utf8"));
const docs: Record<string, GraphDocument> = {
  small: load("small"),
  medium: load("medium"),
  gcp: load("gcp"),
  environments: load("environments"),
  "dev-prod": load("dev-prod"),
  hashed: load("hashed"),
};
const smallBase = load("small-base");
const medium = docs.medium as GraphDocument;
const small = docs.small as GraphDocument;

/** What a viewer reads of a layout to place a card, a box or a line. */
const placed = (layout: GraphLayoutView): { nodes: LayoutNode[]; groups: LayoutGroup[]; edges: LayoutEdge[] } => layout;

type Rect = { x: number; y: number; width: number; height: number };
const apart = (a: Rect, b: Rect) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const inside = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** A finding on the first resource of the document, and one on its account. */
function findingsOn(doc: GraphDocument): GraphFinding[] {
  const first = doc.nodes.find((n) => n.kind === "resource");
  assert.ok(first?.type && first.id);
  return [
    { severity: "high", title: "on a resource", type: first.type, id: first.id, account: first.account },
    { severity: "low", title: "on a scope", account: first.account },
  ];
}

/** The same estate listed back to front, with the indexes remapped. */
function reversed(doc: GraphDocument): GraphDocument {
  const last = doc.nodes.length - 1;
  const nodes = doc.nodes.toReversed().map((n) => (n.parent === undefined ? n : { ...n, parent: last - n.parent }));
  return { ...doc, nodes, edges: doc.edges.toReversed().map((e) => ({ from: last - e.from, to: last - e.to })) };
}

/** A graph of `count` unrelated resources in one account. */
function wide(count: number): GraphDocument {
  return {
    ...small,
    nodes: Array.from({ length: count }, (_, i) => ({ kind: "resource" as const, type: "aws_s3_bucket", id: `bucket-${i}`, account: "123456789012" })),
    edges: [],
  };
}

const layouts = (): [string, GraphLayoutView][] => [
  ...Object.entries(docs).map(([name, doc]): [string, GraphLayoutView] => [name, layoutGraphDocument(doc)]),
  ["small, compared, with findings", layoutGraphDocument(small, { base: smallBase, findings: findingsOn(small), title: "Estate" })],
  ["small, delta", layoutGraphDocument(small, { base: smallBase, delta: true })],
  ["medium, with findings", layoutGraphDocument(medium, { findings: findingsOn(medium) })],
];

describe("graph layout", () => {
  it("places every node and box, and every route, inside the canvas", () => {
    for (const [name, layout] of layouts()) {
      assert.ok(layout.nodes.length > 0, name);
      for (const box of [...layout.nodes, ...layout.groups]) {
        assert.ok(box.x >= 0 && box.y >= layout.top && box.x + box.width <= layout.width && box.y + box.height <= layout.height, `${name}: ${box.id}`);
      }
      for (const edge of layout.edges) {
        for (const p of edge.points) assert.ok(p.x >= 0 && p.y >= layout.top && p.x <= layout.width && p.y <= layout.height, `${name}: ${edge.id}`);
      }
    }
  });

  it("keeps the nodes of a box apart from each other, and every box around what is in it", () => {
    for (const [name, layout] of layouts()) {
      const group = new Map(placed(layout).groups.map((g) => [g.id, g]));
      for (const a of layout.nodes) for (const b of layout.nodes) if (a.id < b.id) assert.ok(apart(a, b), `${name}: ${a.id} and ${b.id}`);
      for (const node of layout.nodes) {
        for (let id: string | null | undefined = node.group; id; id = group.get(id)?.parent) {
          assert.ok(inside(group.get(id) as Rect, node), `${name}: ${node.id} in ${id}`);
        }
      }
      for (const a of layout.groups) {
        for (const b of layout.groups) if (a.id < b.id && a.parent === b.parent) assert.ok(apart(a, b), `${name}: ${a.id} and ${b.id}`);
        assert.ok(a.parent === null || group.has(a.parent), `${name}: ${a.id} has a parent that is a box`);
      }
    }
  });

  it("has an end for every edge, a box for every node, and ids nothing else shares", () => {
    for (const [name, layout] of layouts()) {
      const ids = [...layout.nodes, ...layout.groups, ...layout.edges].map((x) => x.id);
      assert.equal(new Set(ids).size, ids.length, `${name}: ids are unique`);
      const nodes = new Set(layout.nodes.map((n) => n.id));
      const groups = new Set(layout.groups.map((g) => g.id));
      for (const edge of layout.edges) {
        assert.ok(nodes.has(edge.source) && nodes.has(edge.target), `${name}: ${edge.id}`);
        assert.equal(edge.kind, "reference");
        assert.ok(edge.points.length >= 2, `${name}: ${edge.id} has a route`);
      }
      for (const node of layout.nodes) assert.ok(groups.has(node.group), `${name}: ${node.id}`);
    }
  });

  it("gives the same layout twice, and from any order of the document", () => {
    for (const [name, doc] of Object.entries(docs)) {
      const once = JSON.stringify(layoutGraphDocument(doc));
      assert.equal(JSON.stringify(layoutGraphDocument(doc)), once, name);
      assert.equal(JSON.stringify(layoutGraphDocument(reversed(doc))), once, `${name}, listed back to front`);
    }
    const options = { base: smallBase, findings: findingsOn(small) };
    assert.equal(JSON.stringify(layoutGraphDocument(reversed(small), options)), JSON.stringify(layoutGraphDocument(small, options)));
  });

  it("carries what the picture marks: what changed, findings by severity, and the counts", () => {
    const layout = layoutGraphDocument(small, { base: smallBase, findings: findingsOn(small) });
    assert.equal(layout.schema, GRAPH_LAYOUT_SCHEMA);
    assert.equal(layout.compared, true);
    const changes = new Set(layout.nodes.map((n) => n.badges.change));
    assert.ok(changes.has("added") || changes.has("changed") || changes.has("removed"));
    for (const node of layout.nodes) assert.equal(node.badges.change, node.status === "added" || node.status === "removed" || node.status === "changed" ? node.status : null);
    const onNode = layout.nodes.flatMap((n) => (n.badges.findings ? [n.badges.findings] : []));
    assert.deepEqual(onNode.map((f) => [f.count, f.worst, f.bySeverity]), [[1, "high", { high: 1 }]]);
    assert.deepEqual(layout.groups.flatMap((g) => (g.badges.findings ? [g.badges.findings.bySeverity] : [])), [{ low: 1 }]);
    assert.ok(layout.changes);
    assert.equal(layout.findings?.total, 2);
    assert.equal(layoutGraphDocument(small).nodes.every((n) => n.badges.findings === null && n.badges.change === null), true);
  });

  it("says when it cut the estate, and what it left out", () => {
    const whole = layoutGraphDocument(medium);
    assert.equal(whole.cut, null);
    const cut = layoutGraphDocument(medium, { maxNodes: 5 });
    assert.deepEqual(cut.cut, { maxNodes: 5, nodes: whole.nodes.length - 5, edges: whole.edges.length - cut.edges.length });
    assert.equal(cut.nodes.length, 5);
    assert.deepEqual(cut.nodes.map((n) => n.id), whole.nodes.slice(0, 5).map((n) => n.id));
    assert.ok(cut.footer.some((line) => line.startsWith("Cut to the first 5 resources")));
    const nodes = new Set(cut.nodes.map((n) => n.id));
    for (const edge of cut.edges) assert.ok(nodes.has(edge.source) && nodes.has(edge.target));
    const groups = new Set(cut.groups.map((g) => g.id));
    for (const node of cut.nodes) assert.ok(groups.has(node.group));
    for (const group of cut.groups) assert.ok(group.parent === null || groups.has(group.parent));
    assert.ok(cut.groups.length <= whole.groups.length);
    assert.equal(JSON.stringify(layoutGraphDocument(medium, { maxNodes: 5 })), JSON.stringify(cut));
  });

  it("cuts an estate larger than MAX_GRAPH_NODES by default, and not one of exactly that size", () => {
    const exact = layoutGraphDocument(wide(MAX_GRAPH_NODES));
    assert.equal(exact.cut, null);
    assert.equal(exact.nodes.length, MAX_GRAPH_NODES);
    const over = layoutGraphDocument(wide(MAX_GRAPH_NODES + 3));
    assert.deepEqual(over.cut, { maxNodes: MAX_GRAPH_NODES, nodes: 3, edges: 0 });
    assert.equal(over.nodes.length, MAX_GRAPH_NODES);
  });

  it("lays out an estate with nothing to draw as an empty canvas", () => {
    const layout = layoutGraphDocument({ ...small, nodes: [], edges: [] });
    assert.deepEqual([layout.nodes, layout.groups, layout.edges, layout.width, layout.height], [[], [], [], 0, 0]);
    assert.equal(layout.cut, null);
  });
});

describe("the SVG is drawn from the layout", () => {
  const rects = (svg: string, rx: number) =>
    [...svg.matchAll(new RegExp(`<rect x="(-?[\\d.]+)" y="(-?[\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" rx="${rx}"`, "g"))].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
      width: Number(m[3]),
      height: Number(m[4]),
    }));
  const pick = (r: Rect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

  it("puts every card, box and route where the layout says", () => {
    for (const [name, doc, options] of [
      ["small", small, {}],
      ["medium", medium, {}],
      ["environments", docs.environments as GraphDocument, {}],
      ["small, titled and compared", small, { base: smallBase, title: "Estate", findings: findingsOn(small) }],
      ["medium, cut", medium, { maxNodes: 7 }],
    ] as const) {
      const view = projectGraph(doc, options);
      const layout = layoutGraphView(view);
      const svg = renderGraphSvg(view);
      assert.deepEqual(rects(svg, 9), layout.nodes.map(pick), `${name}: cards`);
      assert.deepEqual(rects(svg, 12), layout.groups.map(pick), `${name}: boxes`);
      const starts = [...svg.matchAll(/<path d="M (-?[\d.]+) (-?[\d.]+)[^"]*" fill="none"/g)].map((m) => [Number(m[1]), Number(m[2])]);
      assert.deepEqual(starts, layout.edges.filter((e) => e.points.length >= 2).map((e) => [e.points[0]?.x, e.points[0]?.y]), `${name}: routes`);
      assert.ok(svg.includes(`width="${Math.ceil(Math.max(layout.width, 360))}"`), `${name}: canvas`);
    }
  });

  it("writes the layout's own words: headings, kinds, labels and titles", () => {
    const view = projectGraph(small, { base: smallBase, title: "Estate" });
    const layout = layoutGraphView(view);
    const svg = renderGraphSvg(view);
    for (const group of layout.groups) assert.ok(svg.includes(`>${group.heading}</text>`), group.heading);
    for (const node of layout.nodes) {
      assert.ok(svg.includes(`<title>${node.title}</title>`), node.title);
      assert.ok(svg.includes(`>${node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}</text>`), node.label);
    }
    for (const line of [...layout.header, ...layout.footer]) assert.ok(svg.includes(`>${line}</text>`), line);
    assert.equal(layout.top, 2 * 18 + 6);
    assert.ok(layout.nodes.every((n) => n.y >= layout.top));
  });
});

describe("strings in the layout", () => {
  const evil = `</text><script>alert(1)</script>"&'\u0007\u0000`;
  const doc: GraphDocument = {
    ...small,
    nodes: small.nodes.map((n) => (n.kind === "resource" ? { ...n, id: `${evil}${n.id}`, type: `${n.type}${evil}`, region: evil, environment: evil } : n)),
  };

  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

  it("are text: no control characters, no length without bound, whatever the document holds", () => {
    const layout = layoutGraphDocument(doc, { title: `${evil}${"t".repeat(1000)}`, findings: [{ severity: "info", title: evil, type: `${small.nodes[0]?.type}${evil}`, id: evil }] });
    const all = strings(layout);
    assert.ok(all.length > 20);
    for (const s of all) {
      assert.ok(![...s].some((ch) => ch < " " && ch !== "\t"), JSON.stringify(s));
      assert.ok(s.length <= 400, `${s.length} characters`);
    }
    assert.ok(all.some((s) => s.includes("<script>")), "markup is kept as text for the viewer to show as text");
  });

  it("are the values the SVG escapes, so nothing is written to it twice", () => {
    const view = projectGraph(doc, { title: evil });
    const layout = layoutGraphView(view);
    const svg = renderGraphSvg(view);
    assert.ok(!svg.includes("<script"));
    assert.ok(!svg.includes("\u0007") && !svg.includes("\u0000"));
    assert.ok(svg.includes("&lt;script&gt;"));
    assert.ok(!svg.includes("&amp;lt;"), "escaped once");
    for (const node of layout.nodes) assert.ok(svg.includes(`<title>${node.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</title>`));
  });
});

describe("schemas/graph-layout.v1.schema.json", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/graph-layout.v1.schema.json", import.meta.url), "utf8")) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const valid = ajv.compile(schema);
  const accepts = (value: unknown) => valid(value) === true;

  it("is the schema the engine's own validator is", () => {
    assert.equal((schema as { $id?: string }).$id, "https://github.com/hibiscus-ctrl/terragram/schemas/graph-layout.v1.schema.json");
    for (const [name, layout] of layouts()) {
      assert.ok(accepts(layout), `${name}: ${JSON.stringify(valid.errors)}`);
      assert.deepEqual(graphLayoutSchema.parse(layout), layout, name);
    }
  });

  it("accepts the committed fixtures", () => {
    const dir = new URL("./fixtures/graph/layout/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 2);
    for (const file of files) {
      const value = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as unknown;
      assert.ok(accepts(value), `${file}: ${JSON.stringify(valid.errors)}`);
      assert.ok(graphLayoutSchema.safeParse(value).success, file);
    }
  });

  it("refuses a layout that is not one", () => {
    const base = JSON.parse(JSON.stringify(layoutGraphDocument(small, { base: smallBase }))) as Record<string, any>;
    const mutate = (change: (copy: Record<string, any>) => void) => {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      change(copy);
      return copy;
    };
    assert.ok(accepts(base));
    assert.ok(!accepts(mutate((c) => { c.schema = "diagram.graph-layout/v2"; })));
    assert.ok(!accepts(mutate((c) => { delete c.cut; })));
    assert.ok(!accepts(mutate((c) => { delete c.nodes[0].x; })));
    assert.ok(!accepts(mutate((c) => { c.nodes[0].x = 1.5; })));
    assert.ok(!accepts(mutate((c) => { c.nodes[0].status = "deleted"; })));
    assert.ok(!accepts(mutate((c) => { c.nodes[0].badges.change = "moved"; })));
    assert.ok(!accepts(mutate((c) => { c.edges[0].kind = "iam"; })));
    assert.ok(!accepts(mutate((c) => { c.groups[0].kind = "region"; })));
    assert.ok(!accepts(mutate((c) => { c.cut = { maxNodes: 5, nodes: 0, edges: 0 }; })));
  });
});
