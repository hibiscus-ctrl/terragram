// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  GRAPH_LAYOUT_SCHEMA,
  type GraphDocument,
  type GraphFinding,
  type GraphLayoutView,
  graphLayoutSchema,
  type IconQuery,
  type IconRef,
  type IconResolver,
  type LayoutEdge,
  type LayoutGroup,
  type LayoutNode,
  layoutGraphDocument,
  layoutGraphView,
  type LayoutViewOptions,
  DEFAULT_ASPECT,
  GRAPH_LEVELS,
  MAX_ASPECT,
  MIN_ASPECT,
  MAX_GRAPH_NODES,
  CATEGORY_GLYPHS,
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
  large: load("large"),
  azure: load("azure"),
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
  ["medium, services", layoutGraphDocument(medium, { level: "services" })],
  ["medium, overview", layoutGraphDocument(medium, { level: "overview", findings: findingsOn(medium) })],
  ["large, services", layoutGraphDocument(docs.large as GraphDocument, { level: "services" })],
  ["environments, overview", layoutGraphDocument(docs.environments as GraphDocument, { level: "overview" })],
  ["large, focus on a hub", layoutGraphDocument(docs.large as GraphDocument, { focus: { node: "n28", hops: 2 } })],
  ["small, compared, delta, overview", layoutGraphDocument(small, { base: smallBase, delta: true, level: "overview" })],
  ["medium, with icons", layoutGraphDocument(medium, { icon: (n) => (n.cloud === "aws" ? { symbol: `icon-${n.service.replace(".", "-")}` } : undefined) })],
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
      // The canvas is the layout's, or wider where a note under the picture needs the room.
      const wanted = Math.ceil(Math.max(layout.width, 360, ...layout.footer.map((line) => 48 + line.length * 6.2)));
      assert.ok(svg.includes(`width="${wanted}"`), `${name}: canvas`);
    }
  });

  it("writes the layout's own words: headings, kinds, labels and titles", () => {
    const view = projectGraph(small, { base: smallBase, title: "Estate" });
    const layout = layoutGraphView(view);
    const svg = renderGraphSvg(view);
    for (const group of layout.groups) assert.ok(svg.includes(`>${group.heading}</text>`), group.heading);
    for (const node of layout.nodes) {
      assert.ok(svg.includes(`<title>${node.title}</title>`), node.title);
      assert.ok(svg.includes(`>${node.label.length > 24 ? `${node.label.slice(0, 12)}…${node.label.slice(-11)}` : node.label}</text>`), node.label);
    }
    for (const line of [...layout.header, ...layout.footer]) assert.ok(svg.includes(`>${line}</text>`), line);
    assert.equal(layout.top, 2 * 18 + 6);
    assert.ok(layout.nodes.every((n) => n.y >= layout.top));
  });
});

describe("the shape of the picture", () => {
  const ratio = (layout: GraphLayoutView) => layout.width / layout.height;
  const large = docs.large as GraphDocument;

  it("packs boxes onto rows toward 16:10 instead of laying them side by side in a strip", () => {
    for (const [name, doc] of Object.entries({ medium, large })) {
      const layout = layoutGraphDocument(doc);
      assert.ok(ratio(layout) > 1.2 && ratio(layout) < 2.4, `${name} is ${layout.width} x ${layout.height}`);
    }
    const strip = layoutGraphDocument(wide(60));
    assert.ok(ratio(strip) > 1.2 && ratio(strip) < 2.4, `60 lone cards are ${strip.width} x ${strip.height}`);
  });

  it("packs toward the aspect asked for, and the same one when none is", () => {
    const [tall, flat] = [layoutGraphDocument(wide(60), { aspect: 0.7 }), layoutGraphDocument(wide(60), { aspect: 3 })];
    assert.ok(ratio(tall) < 1 && ratio(flat) > 2.2, `${ratio(tall)} and ${ratio(flat)}`);
    assert.equal(JSON.stringify(layoutGraphDocument(large, { aspect: 1.6 })), JSON.stringify(layoutGraphDocument(large)));
    assert.notEqual(JSON.stringify(layoutGraphDocument(large, { aspect: 3 })), JSON.stringify(layoutGraphDocument(large)));
    assert.ok(renderGraphSvg(projectGraph(large), { aspect: 3 }).includes(`width="${Math.ceil(layoutGraphDocument(large, { aspect: 3 }).width)}"`));
  });

  it("holds the aspect at every level, for the fixtures and for estates whose resources refer to each other", () => {
    const TYPES = ["azurerm_subnet", "azurerm_linux_virtual_machine", "azurerm_mssql_database", "azurerm_storage_account", "azurerm_key_vault", "azurerm_service_plan", "azurerm_redis_cache", "azurerm_cosmosdb_account", "azurerm_container_registry", "azurerm_servicebus_namespace", "azurerm_public_ip", "azurerm_log_analytics_workspace"];
    /** A subscription of `count` resources of a few types, each referring to one of the first ten and to its neighbour: one connected cluster at every level. */
    const connected = (count: number): GraphDocument => ({
      ...docs.azure,
      nodes: Array.from({ length: count }, (_, i) => ({ kind: "resource" as const, type: TYPES[i % TYPES.length] as string, id: `r${i}`, account: "sub" })),
      edges: Array.from({ length: count - 1 }, (_, i) => ({ from: i + 1, to: i % 10 })),
    });
    const estates: Record<string, GraphDocument> = { ...docs, "connected 60": connected(60), "connected 200": connected(200) };
    const measured: string[] = [];
    for (const [name, doc] of Object.entries(estates)) {
      for (const level of GRAPH_LEVELS) {
        // A cluster that dagre lays out tall is wrapped to be narrower, never stretched wider, so the estates built to be one cluster are asked for 1 and 1.6 only.
        for (const aspect of name.startsWith("connected") ? [1, DEFAULT_ASPECT] : [1, DEFAULT_ASPECT, 2.4]) {
          const layout = layoutGraphDocument(doc, { level, aspect });
          // One or two boxes cannot be reshaped: a picture needs six cards before its shape is the packing's to choose.
          if (layout.nodes.length < 6) continue;
          const picture = layout.width / (layout.height - layout.top);
          const off = Math.max(picture / aspect, aspect / picture);
          measured.push(`${name} ${level} @${aspect}: ${picture.toFixed(2)}`);
          assert.ok(off <= 1.6, `${name} at ${level}, aspect ${aspect}, is ${layout.width} x ${layout.height - layout.top} (${picture.toFixed(2)})`);
        }
      }
    }
    assert.ok(measured.length > 50, `only ${measured.length} pictures were measured`);
    // The Azure estate was 5.6 : 1 at Services (and 27 : 1 detailed) when a cluster was not wrapped.
    for (const level of GRAPH_LEVELS.filter((l) => l !== "overview")) {
      const layout = layoutGraphDocument(docs.azure as GraphDocument, { level });
      assert.ok(layout.width / (layout.height - layout.top) < 2.2, level);
    }
  });

  it("wraps a cluster that is wider than the picture without losing a card or a line", () => {
    const services = layoutGraphDocument(docs.azure as GraphDocument, { level: "services" });
    const detailed = projectGraph(docs.azure as GraphDocument, { level: "services" });
    assert.equal(services.nodes.length, detailed.nodes.length);
    assert.equal(services.edges.length, detailed.edges.length);
    assert.ok(services.edges.every((e) => e.points.length >= 2), "a line was left without a route");
    for (const a of services.nodes) for (const b of services.nodes) if (a !== b) assert.ok(apart(a, b), `${a.id} overlaps ${b.id}`);
    const box = services.groups[0] as LayoutGroup;
    for (const n of services.nodes) assert.ok(inside(box, n), `${n.id} is outside its box`);
  });

  it("refuses an aspect that is not a number in bounds", () => {
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MIN_ASPECT - 0.01, MAX_ASPECT + 0.01, "2" as unknown as number]) {
      assert.throws(() => layoutGraphDocument(small, { aspect }), RangeError, String(aspect));
    }
    for (const aspect of [MIN_ASPECT, MAX_ASPECT]) assert.ok(layoutGraphDocument(small, { aspect }).nodes.length > 0);
  });

  it("keeps the same layout from any order of a document that is packed, with the aspect asked for", () => {
    for (const aspect of [0.7, 3]) {
      assert.equal(JSON.stringify(layoutGraphDocument(reversed(large), { aspect })), JSON.stringify(layoutGraphDocument(large, { aspect })));
    }
  });

  it("routes a line between two boxes through a gap, not over the cards it is not drawn to", () => {
    const layout = layoutGraphDocument(large);
    const cards = new Map(layout.nodes.map((n) => [n.id, n]));
    let crossing = 0;
    let routed = 0;
    for (const edge of layout.edges) {
      const [from, to] = [cards.get(edge.source), cards.get(edge.target)];
      if (!from || !to || from.group === to.group) continue;
      routed++;
      for (let i = 0; i + 1 < edge.points.length; i++) {
        const [p, q] = [edge.points[i], edge.points[i + 1]] as [{ x: number; y: number }, { x: number; y: number }];
        const line = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.abs(p.x - q.x), height: Math.abs(p.y - q.y) };
        for (const card of layout.nodes) if (card !== from && card !== to && !apart(card, line) && line.width + line.height > 0) crossing++;
      }
    }
    assert.ok(routed > 0);
    assert.ok(crossing <= routed / 4, `${crossing} crossings in ${routed} routes`);
  });

  it("gives a card room for a long resource type, and shows both ends of one that is longer", () => {
    const type = "aws_s3_bucket_server_side_encryption_configuration";
    const doc: GraphDocument = { ...small, nodes: [{ kind: "resource", type: "aws_s3_bucket_public_access_block", id: "a", account: "1" }, { kind: "resource", type, id: "b", account: "1" }], edges: [] };
    const layout = layoutGraphDocument(doc);
    assert.ok(layout.nodes.every((n) => n.width >= 216));
    const svg = renderGraphSvg(projectGraph(doc));
    assert.ok(svg.includes(">aws_s3_bucket_public_access_block</text>"));
    assert.ok(svg.includes(">aws_s3_bucket_serv…ion_configuration</text>"));
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

describe("graph layout levels and icons", () => {
  it("says its level and focus, and what each card of the Services and Overview levels stands for", () => {
    const detailed = layoutGraphDocument(medium);
    assert.equal(detailed.level, "detailed");
    assert.equal(detailed.focus, null);
    assert.ok(detailed.nodes.every((n) => n.aggregate === undefined && n.service.length > 0));
    assert.ok(detailed.edges.every((e) => e.count === 1));

    const services = layoutGraphDocument(medium, { level: "services" });
    const lambda = services.nodes.find((n) => n.service === "aws.lambda");
    assert.equal(lambda?.label, "Lambda ×2");
    assert.equal(lambda?.kind, "aws_lambda_function");
    assert.equal(lambda?.aggregate?.level, "services");
    assert.deepEqual(lambda?.aggregate?.types, [{ type: "aws_lambda_function", count: 2 }]);
    assert.match(lambda?.title ?? "", /^Lambda ×2: 2 resources; aws_lambda_function 2/);
    const subnets = services.nodes.find((n) => n.service === "aws.vpc" && (n.aggregate?.count ?? 0) > 3);
    assert.equal(subnets?.kind, "aws_subnet +5 more");

    const overview = layoutGraphDocument(medium, { level: "overview" });
    const card = overview.nodes.find((n) => n.kind.startsWith("module"));
    assert.equal(card?.kind, "module · 3 resources");
    assert.match(card?.title ?? "", /^s3-bucket\/aws 4\.1\.0: 3 resources; storage 2, other 1/);
    assert.equal(card?.height, 84, "a summary card has room for its counts");
    assert.ok(overview.nodes.filter((n) => n.aggregate !== undefined).every((n) => n.height === 84));
    assert.ok(overview.footer.some((line) => line.startsWith("Overview:")));

    const focus = layoutGraphDocument(medium, { focus: { node: "n25", hops: 1 } });
    assert.deepEqual(focus.focus, { node: "n25", label: "vpc-0a1b2c3d", hops: 1, shown: focus.nodes.length, of: detailed.nodes.length });
    assert.ok(focus.footer.some((line) => line.startsWith("Focus: vpc-0a1b2c3d and what is within 1 reference of it")));
  });

  it("is the same layout from the same options, and a view the same as the document", () => {
    const options = { level: "services", aspect: 1.3 } as const;
    assert.deepEqual(layoutGraphDocument(medium, options), layoutGraphDocument(medium, options));
    assert.deepEqual(layoutGraphView(projectGraph(medium, { level: "services" }), { aspect: 1.3 }), layoutGraphDocument(medium, options));
  });

  it("asks the resolver for each node once and carries its answer, but not for a summary card", () => {
    const asked: string[] = [];
    const icon: IconResolver = (node: IconQuery): IconRef | undefined => {
      asked.push(`${node.id} ${node.service} ${node.level}`);
      return node.service === "aws.ec2" ? { href: "https://icons.example/ec2.svg" } : node.service === "aws.iam" ? { symbol: "i-iam" } : undefined;
    };
    const options: LayoutViewOptions = { icon, aspect: 1.6 };
    const layout = layoutGraphDocument(small, options);
    assert.equal(asked.length, layout.nodes.length);
    assert.ok(asked.includes("n3 aws.ec2 detailed"));
    assert.deepEqual(layout.nodes.find((n) => n.id === "n3")?.icon, { href: "https://icons.example/ec2.svg" });
    assert.deepEqual(layout.nodes.find((n) => n.service === "aws.iam")?.icon, { symbol: "i-iam" });
    assert.equal(layout.nodes.find((n) => n.service === "aws.vpc")?.icon, undefined);

    const overview: string[] = [];
    layoutGraphDocument(medium, { level: "overview", icon: (n) => void overview.push(n.id) });
    assert.deepEqual(overview, []);
    const services: string[] = [];
    layoutGraphDocument(medium, { level: "services", icon: (n) => void services.push(n.service) });
    assert.ok(services.includes("aws.lambda") && services.length > 5);
  });

  it("refuses an icon it cannot place, rather than draw something else", () => {
    const give = (answer: unknown) => () => layoutGraphDocument(small, { icon: () => answer as never });
    for (const bad of [
      "ec2",
      {},
      { href: "" },
      { href: "javascript:alert(1)" },
      { href: "http://insecure.example/a.svg" },
      { href: "//host.example/a.svg" },
      { href: "data:text/html,<script>" },
      { href: "https://a.example/a.svg", symbol: "x" },
      { href: 3 },
      { symbol: "has space" },
      { symbol: "1starts-with-digit" },
      { symbol: "" },
      { href: "x".repeat(40000) },
    ]) {
      assert.throws(give(bad), TypeError, JSON.stringify(bad).slice(0, 60));
    }
    for (const good of [
      { href: "https://icons.example/a.svg" },
      { href: "/icons/a.svg" },
      { href: "icons/a.svg" },
      { href: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
      { href: "data:image/png;base64,AAAA" },
      { symbol: "aws-ec2" },
      { symbol: "icon:ec2.v1" },
    ]) {
      assert.deepEqual(layoutGraphDocument(small, { icon: () => good }).nodes[0]?.icon, good);
    }
  });

  it("draws the engine's own glyph of the category without a resolver, and no image", () => {
    const svg = renderGraphSvg(projectGraph(medium));
    assert.ok(!svg.includes("<image") && !svg.includes("<use"), "the engine ships no vendor art");
    const glyphs = svg.match(/<g transform="translate\(\d+ \d+\)" fill="none" stroke="#[0-9a-f]{6}"/g) ?? [];
    assert.equal(glyphs.length, projectGraph(medium).nodes.length, "one on each card");
    for (const category of ["network", "compute", "storage", "identity", "data", "other"] as const) assert.ok(CATEGORY_GLYPHS[category].length > 20);
  });

  it("draws an icon in place of the glyph: an image for an href, a use for a symbol", () => {
    const view = projectGraph(small);
    const svg = renderGraphSvg(view, {
      icon: (n) => (n.service === "aws.ec2" ? { href: "https://icons.example/ec2.svg?a=1&b=<2>" } : n.service === "aws.iam" ? { symbol: "i-iam" } : undefined),
    });
    assert.equal((svg.match(/<image /g) ?? []).length, 1);
    assert.ok(svg.includes('href="https://icons.example/ec2.svg?a=1&amp;b=&lt;2&gt;"'), "escaped once");
    assert.equal((svg.match(/<use href="#i-iam"/g) ?? []).length, 2);
    const glyphs = (svg.match(/<g transform="translate/g) ?? []).length;
    assert.equal(glyphs, view.nodes.length - 3, "a card with an icon has no glyph");
    assert.ok(!svg.includes("<script"));
  });

  it("draws the number of references on a line that stands for several, and counts on a summary card", () => {
    const services = renderGraphSvg(projectGraph(medium, { level: "services" }));
    assert.match(services, /<title>\d+ references<\/title>/);
    assert.match(services, />×\d+<\/text>/);
    const overview = renderGraphSvg(projectGraph(medium, { level: "overview" }));
    assert.ok(!overview.includes("<use") && !overview.includes("<image"));
    assert.match(overview, /<rect x="\d+" y="\d+" width="9" height="9" rx="2" fill="#[0-9a-f]{6}"\/>/, "a square per category");
    assert.match(overview, />network<\/text>/, "the legend names the categories");
  });
});

describe("schemas/graph-layout.v2.schema.json", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/graph-layout.v2.schema.json", import.meta.url), "utf8")) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const valid = ajv.compile(schema);
  const accepts = (value: unknown) => valid(value) === true;

  it("is the schema the engine's own validator is", () => {
    assert.equal((schema as { $id?: string }).$id, "https://github.com/hibiscus-ctrl/terragram/schemas/graph-layout.v2.schema.json");
    for (const [name, layout] of layouts()) {
      assert.ok(accepts(layout), `${name}: ${JSON.stringify(valid.errors)}`);
      assert.deepEqual(graphLayoutSchema.parse(layout), layout, name);
    }
  });

  it("is what the committed example layouts hold: the same estates, laid out again (UPDATE_GOLDEN=1 rewrites them)", () => {
    const examples: Record<string, GraphLayoutView> = {
      "small.json": layoutGraphDocument(small),
      "small-compared-findings.json": layoutGraphDocument(small, { base: smallBase, findings: findingsOn(small), title: "Estate" }),
      "medium-cut.json": layoutGraphView(projectGraph(medium, { maxNodes: 6 })),
      "medium-services.json": layoutGraphDocument(medium, { level: "services" }),
      "medium-overview.json": layoutGraphDocument(medium, { level: "overview", findings: findingsOn(medium) }),
      "medium-focus.json": layoutGraphDocument(medium, { level: "services", focus: { node: "a3", hops: 1 } }),
    };
    for (const [file, layout] of Object.entries(examples)) {
      const url = new URL(`./fixtures/graph/layout/${file}`, import.meta.url);
      const text = `${JSON.stringify(layout, null, 2)}\n`;
      if (process.env.UPDATE_GOLDEN === "1") writeFileSync(url, text);
      else assert.equal(readFileSync(url, "utf8"), text, `${file} differs; UPDATE_GOLDEN=1 rewrites it`);
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
    assert.ok(!accepts(mutate((c) => { c.schema = "diagram.graph-layout/v1"; })));
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
