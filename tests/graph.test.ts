// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  DEFAULT_GLUE,
  diffGraphs,
  type GlueRule,
  type GraphDiff,
  type GraphDocument,
  GraphDocumentError,
  type GraphFinding,
  type GraphView,
  graphDocumentSchema,
  findingsFromOcsf,
  findingsFromReview,
  parseFindings,
  parseGraphDocument,
  projectGraph,
  renderGraphMermaid,
  renderGraphSvg,
  SEVERITIES,
  type ProjectOptions,
  type Severity,
  type ViewEdge,
  type ViewGroup,
  type ViewNode,
} from "terragram-engine/graph";

import { layoutGraph } from "../packages/engine/src/graph/layout.ts";

/**
 * The Graph renderer: infraharvest's graph/v1 document in, a deterministic diagram out.
 * The goldens in tests/fixtures/graph/golden are the diagrams themselves; regenerate them
 * with `UPDATE_GOLDEN=1 npm test` and read the diff before committing it.
 */

const fixture = (name: string) => new URL(`./fixtures/graph/${name}`, import.meta.url);
const load = (name: string): GraphDocument => parseGraphDocument(readFileSync(fixture(`${name}.json`), "utf8"));
const small = load("small");
const smallBase = load("small-base");
const medium = load("medium");

function golden(name: string, actual: string): void {
  const path = fixture(`golden/${name}`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path.pathname), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `${name} differs from its golden; UPDATE_GOLDEN=1 rewrites it`);
}

/** The same estate with its nodes and edges listed in another order (indexes remapped). */
function shuffled(doc: GraphDocument, seed: number): GraphDocument {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = doc.nodes.map((_, i) => i).sort(() => random() - 0.5);
  const newIndex = new Map(order.map((old, i) => [old, i]));
  const nodes = order.map((old) => {
    const node = structuredClone(doc.nodes[old] as GraphDocument["nodes"][number]);
    if (node.parent !== undefined) node.parent = newIndex.get(node.parent) as number;
    return node;
  });
  const edges = doc.edges
    .map((e) => ({ from: newIndex.get(e.from) as number, to: newIndex.get(e.to) as number }))
    .sort(() => random() - 0.5);
  return { ...doc, nodes, edges };
}

const view = (doc: GraphDocument, options: ProjectOptions = {}): GraphView => projectGraph(doc, options);
const nodeOf = (v: GraphView, type: string): ViewNode | undefined => v.nodes.find((n) => n.type === type);
const scopes = (v: GraphView): ViewGroup[] => v.groups.filter((g) => g.kind === "scope");
const refs = (v: GraphView, type: string): ViewEdge[] => v.edges.filter((e) => e.from === nodeOf(v, type)?.id);

describe("graph/v1 schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const jsonSchema = JSON.parse(
    readFileSync(new URL("../schemas/vendor/infraharvest/graph-v1.schema.json", import.meta.url), "utf8"),
  ) as object;
  const validate = ajv.compile(jsonSchema);

  it("is vendored unchanged from infraharvest, with its licence", () => {
    assert.match(readFileSync(new URL("../REUSE.toml", import.meta.url), "utf8"), /schemas\/vendor\/\*\*[\s\S]*Apache-2\.0/);
    assert.equal((jsonSchema as { $id: string }).$id, "https://ignatg.github.io/infraharvest/schemas/graph-v1.schema.json");
  });

  const mutate = (change: (doc: Record<string, unknown>) => void): unknown => {
    const doc = structuredClone(small) as unknown as Record<string, unknown>;
    change(doc);
    return doc;
  };
  const node = (doc: Record<string, unknown>, i: number) => (doc.nodes as Record<string, unknown>[])[i] as Record<string, unknown>;

  const cases: [string, unknown, boolean][] = [
    ["the small fixture", small, true],
    ["the medium fixture", medium, true],
    ["the base fixture", smallBase, true],
    ["no nodes or edges", mutate((d) => { d.nodes = []; d.edges = []; }), true],
    ["hashed ids", mutate((d) => { d.redaction = { ids_hashed: true, hash_alg: "hmac-sha256" }; }), true],
    ["another cloud", mutate((d) => { d.cloud = "google"; }), true],
    ["an unknown cloud", mutate((d) => { d.cloud = "oracle"; }), false],
    ["an unknown field", mutate((d) => { d.extra = 1; }), false],
    ["a wrong schema id", mutate((d) => { d.schema = "infraharvest/graph/v2"; }), false],
    ["a run id that is not a uuid", mutate((d) => { d.run_id = "run-1"; }), false],
    ["a timestamp with an offset", mutate((d) => { d.generated_at = "2026-11-20T10:00:00+01:00"; }), false],
    ["a missing tool", mutate((d) => { delete d.tool; }), false],
    ["a resource without a type", mutate((d) => { delete node(d, 1).type; }), false],
    ["a resource without an account", mutate((d) => { delete node(d, 1).account; }), false],
    ["a resource with a source", mutate((d) => { node(d, 1).source = "x/y/z"; }), false],
    ["a module without a source", mutate((d) => { delete node(d, 0).source; }), false],
    ["a module with a type", mutate((d) => { node(d, 0).type = "aws_vpc"; }), false],
    ["a module with a parent", mutate((d) => { node(d, 0).parent = 0; }), false],
    ["an empty id", mutate((d) => { node(d, 1).id = ""; }), false],
    ["a negative index", mutate((d) => { (d.edges as { from: number }[])[0]!.from = -1; }), false],
    ["a hash algorithm that is not hmac-sha256", mutate((d) => { d.redaction = { ids_hashed: true, hash_alg: "md5" }; }), false],
  ];

  for (const [name, doc, valid] of cases) {
    it(`${valid ? "accepts" : "refuses"} ${name}, in the JSON Schema and in zod alike`, () => {
      assert.equal(validate(doc), valid, JSON.stringify(validate.errors));
      assert.equal(graphDocumentSchema.safeParse(doc).success, valid);
    });
  }

  it("also refuses what the JSON Schema cannot say: an edge or a parent that points at nothing", () => {
    const dangling = mutate((d) => { (d.edges as { to: number }[])[0]!.to = 99; });
    assert.throws(() => parseGraphDocument(dangling), /edges\.0\.to: no node 99/);
    const notAModule = mutate((d) => { node(d, 1).parent = 2; });
    assert.throws(() => parseGraphDocument(notAModule), /nodes\.1\.parent: node 2 is not a module call/);
  });

  it("reads JSON text, and says so when it is not JSON or not a graph", () => {
    assert.equal(parseGraphDocument(JSON.stringify(small)).nodes.length, small.nodes.length);
    assert.throws(() => parseGraphDocument("{"), GraphDocumentError);
    assert.throws(() => parseGraphDocument("{}"), /not an infraharvest graph\/v1 document:\n.*schema/);
    const many = { ...small, nodes: Array.from({ length: 9 }, () => ({ kind: "resource" })) };
    assert.throws(() => parseGraphDocument(many), /\.\.\. and \d+ more/);
  });
});

describe("projecting a graph", () => {
  it("nests resources in their module call inside their account, and keeps a card for a module that is referred to", () => {
    const v = view(small);
    assert.deepEqual(v.groups.map((g) => [g.id, g.kind, g.parent, g.label]), [
      ["g0", "scope", null, "AWS account 123456789012"],
      ["g1", "module", "g0", "module terraform-aws-modules/vpc/aws"],
    ]);
    assert.equal(v.groups[1]?.detail, "5.13.0");
    const inModule = v.nodes.filter((n) => n.group === "g1");
    assert.deepEqual(inModule.map((n) => n.type).sort(), ["aws_subnet", "aws_vpc", "module call"]);
    assert.ok(v.nodes.filter((n) => n.group === "g0").every((n) => n.type !== "module call"));
  });

  it("gives a module nothing to draw a card for when no line ends at it", () => {
    const quiet = { ...small, edges: small.edges.filter((e) => e.to !== 0) };
    assert.ok(!view(quiet).nodes.some((n) => n.type === "module call"));
  });

  it("names the scope by the cloud: subscription on Azure, project on Google", () => {
    assert.match(scopes(view({ ...small, cloud: "azure" }))[0]?.label ?? "", /^Azure subscription /);
    assert.match(scopes(view({ ...small, cloud: "google" }))[0]?.label ?? "", /^Google Cloud project /);
  });

  it("draws one line per reference, from the resource that refers to the one it refers to", () => {
    const v = view(small);
    const id = (type: string) => v.nodes.find((n) => n.type === type)?.id;
    assert.ok(v.edges.some((e) => e.from === id("aws_instance") && e.to === id("aws_security_group")));
    assert.ok(!v.edges.some((e) => e.from === id("aws_security_group") && e.to === id("aws_instance")));
    assert.equal(refs(v, "aws_security_group").length, 1);
  });

  it("colours a resource by what its type is", () => {
    const category = (type: string) => nodeOf(view(small), type)?.category;
    assert.equal(category("aws_vpc"), "network");
    assert.equal(category("aws_instance"), "compute");
    assert.equal(category("aws_iam_role"), "identity");
    assert.equal(view(medium).nodes.find((n) => n.type === "aws_s3_bucket")?.category, "storage");
    assert.equal(view(medium).nodes.find((n) => n.type === "aws_db_instance")?.category, "data");
  });

  it("shortens an ID to what fits a card, and a hashed one to its first characters", () => {
    const long = { ...small, nodes: small.nodes.map((n) => (n.id === "i-0abc123def456" ? { ...n, id: `${"x".repeat(40)}/last-part` } : n)) };
    assert.ok(view(long).nodes.some((n) => n.label === "last-part"));
    const hashed = { ...small, redaction: { ids_hashed: true, hash_alg: "hmac-sha256" as const }, nodes: small.nodes.map((n) => (n.id === "web-role" ? { ...n, id: "f".repeat(64) } : n)) };
    assert.ok(view(hashed).nodes.some((n) => n.label === "ffffffff"));
  });
});

describe("glue", () => {
  it("hides attachments, associations and Terraform's own plumbing, and says how many", () => {
    const v = view(medium);
    assert.equal(v.hidden.count, 11);
    assert.deepEqual(v.hidden.types, [
      { type: "aws_route_table_association", count: 4 },
      { type: "aws_iam_role_policy_attachment", count: 2 },
      { type: "aws_lb_target_group_attachment", count: 2 },
      { type: "aws_lambda_permission", count: 1 },
      { type: "null_resource", count: 1 },
      { type: "random_id", count: 1 },
    ]);
    // Every resource but the glue, and a card for each of the three module calls the others refer to.
    assert.equal(v.nodes.length, medium.nodes.filter((n) => n.kind === "resource").length - 11 + 3);
    assert.ok(!v.nodes.some((n) => /attachment|association|random_|null_resource/.test(n.type)));
  });

  it("keeps the line a hidden resource carried: the role still reaches its policy", () => {
    const v = view(small);
    const id = (type: string) => v.nodes.find((n) => n.type === type)?.id;
    assert.deepEqual(v.hidden, { count: 1, types: [{ type: "aws_iam_role_policy_attachment", count: 1 }] });
    assert.ok(v.edges.some((e) => e.from === id("aws_iam_role") && e.to === id("aws_iam_policy")));
  });

  it("can be turned off, extended and made to keep a type, because the rule is data", () => {
    assert.equal(view(medium, { glue: false }).hidden.count, 0);
    assert.equal(view(medium, { glue: false }).nodes.length, view(medium).nodes.length + 11);
    const keepRule: GlueRule = { ...DEFAULT_GLUE, keep: ["aws_lambda_permission"] };
    const keepPermission = view(medium, { glue: keepRule });
    assert.equal(keepPermission.hidden.count, 10);
    assert.ok(keepPermission.nodes.some((n) => n.type === "aws_lambda_permission"));
    const hideMore = view(medium, { glue: { ...DEFAULT_GLUE, patterns: [...DEFAULT_GLUE.patterns, "aws_cloudwatch_*"] } });
    assert.equal(hideMore.hidden.count, 13);
    const exact = view(medium, { glue: { types: ["aws_eip"], patterns: [], keep: [] } });
    assert.deepEqual(exact.hidden.types, [{ type: "aws_eip", count: 1 }]);
  });

  it("matches glue globs against the whole type, with `*` the only special character", async () => {
    const { glueMatcher } = await import("../packages/engine/src/graph/glue.ts");
    const glue = glueMatcher({ types: [], patterns: ["*_attachment", "google_*_iam_member", "data.*", "a*b*c"], keep: [] });
    for (const type of ["aws_iam_role_policy_attachment", "google_storage_bucket_iam_member", "data.aws_ami", "abc", "a_b_c"]) {
      assert.ok(glue(type), type);
    }
    for (const type of ["aws_attachment_thing", "google_iam_member", "data", "dataXaws", "acb", "ab"]) {
      assert.ok(!glue(type), type);
    }
    // Regular-expression syntax is literal text, so a hostile pattern costs nothing.
    const literal = glueMatcher({ types: [], patterns: ["(a+)+$"], keep: [] });
    assert.ok(!literal(`${"a".repeat(50_000)}!`));
    assert.ok(literal("(a+)+$"));
  });

  it("never hides a module call, and treats Google IAM bindings as glue", () => {
    const google = {
      ...small,
      cloud: "google" as const,
      nodes: [
        ...small.nodes,
        { kind: "resource" as const, type: "google_project_iam_member", id: "p/roles/viewer/u", account: "123456789012" },
        { kind: "resource" as const, type: "google_service_account", id: "sa", account: "123456789012" },
      ],
    };
    const v = view(google);
    assert.ok(v.hidden.types.some((t) => t.type === "google_project_iam_member"));
    assert.ok(v.nodes.some((n) => n.type === "google_service_account"));
    assert.ok(v.nodes.some((n) => n.type === "module call"));
  });
});

describe("determinism", () => {
  it("renders the same bytes twice", () => {
    const options = { base: smallBase };
    assert.equal(renderGraphSvg(view(small, options)), renderGraphSvg(view(small, options)));
    assert.equal(renderGraphSvg(view(medium)), renderGraphSvg(view(medium)));
    assert.equal(renderGraphMermaid(view(medium)), renderGraphMermaid(view(medium)));
  });

  it("renders the same bytes however the document orders its nodes and edges", () => {
    const svg = renderGraphSvg(view(medium));
    const mermaid = renderGraphMermaid(view(medium));
    const json = JSON.stringify(view(medium));
    for (const seed of [1, 2, 3, 7, 42]) {
      const other = shuffled(medium, seed);
      assert.notDeepEqual(other.nodes, medium.nodes, "the shuffle should move something");
      assert.equal(renderGraphSvg(view(other)), svg, `seed ${seed}`);
      assert.equal(renderGraphMermaid(view(other)), mermaid, `seed ${seed}`);
      assert.equal(JSON.stringify(view(other)), json, `seed ${seed}`);
    }
  });

  it("gives the same comparison however either document is ordered", () => {
    const options = { base: smallBase };
    const expected = renderGraphSvg(view(small, options));
    assert.equal(renderGraphSvg(view(shuffled(small, 5), { base: shuffled(smallBase, 9) })), expected);
    assert.deepEqual(diffGraphs(shuffled(smallBase, 1), shuffled(small, 2)), diffGraphs(smallBase, small));
  });

  it("numbers a module called twice by what it contains, and a resource listed twice by its place", () => {
    const twice = (doc: GraphDocument) => ({
      ...doc,
      nodes: [
        ...doc.nodes,
        { kind: "module" as const, account: "123456789012", source: "terraform-aws-modules/vpc/aws", version: "5.13.0" },
        { kind: "resource" as const, type: "aws_vpc", id: "vpc-0second", account: "123456789012", parent: doc.nodes.length },
        { kind: "resource" as const, type: "aws_vpc", id: "vpc-0a1b2c3d", account: "123456789012", region: "eu-central-1" },
      ],
    });
    const doc = twice(small);
    assert.equal(renderGraphSvg(view(doc)), renderGraphSvg(view(shuffled(doc, 3))));
    assert.equal(view(doc).groups.filter((g) => g.kind === "module").length, 2);
  });

  it("holds whatever is in an ID: markup, quotes and control characters stay inert", () => {
    const evil = `</text><script>alert(1)</script>"&'\u0007`;
    const doc = { ...small, nodes: small.nodes.map((n) => (n.id === "web-role" ? { ...n, id: evil } : n)) };
    const svg = renderGraphSvg(view(doc, { title: evil }));
    assert.ok(!svg.includes("<script"));
    assert.ok(!svg.includes("\u0007"));
    assert.ok(svg.includes("&lt;script&gt;"));
    const mermaid = renderGraphMermaid(view(doc, { title: evil }));
    assert.ok(!mermaid.includes("<script"));
    assert.ok(!mermaid.includes("\u0007"));
    assert.ok(!/["]\s*<\/text>/.test(mermaid));
  });
});

describe("layout", () => {
  it("draws every box around its members and clear of everything else", () => {
    for (const doc of [small, medium]) {
      const v = view(doc);
      const layout = layoutGraph(v);
      const inside = (outer: { x: number; y: number; width: number; height: number }, inner: typeof outer) =>
        inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
      const apart = (a: typeof layout.nodes extends Map<string, infer B> ? B : never, b: typeof a) =>
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      const ancestors = (id: string): string[] => {
        const group = v.groups.find((g) => g.id === id);
        return group?.parent ? [group.parent, ...ancestors(group.parent)] : [];
      };

      for (const node of v.nodes) {
        const box = layout.nodes.get(node.id);
        assert.ok(box, node.id);
        const chain = [node.group, ...ancestors(node.group)];
        for (const group of v.groups) {
          const around = layout.groups.get(group.id);
          assert.ok(around, group.id);
          assert.equal(inside(around, box), chain.includes(group.id), `${node.id} and ${group.id}`);
        }
      }
      for (const a of v.nodes) for (const b of v.nodes) if (a.id < b.id) assert.ok(apart(layout.nodes.get(a.id)!, layout.nodes.get(b.id)!), `${a.id} ${b.id}`);
      for (const a of v.groups) {
        for (const b of v.groups) {
          if (a.id >= b.id || a.parent !== b.parent) continue;
          assert.ok(apart(layout.groups.get(a.id)!, layout.groups.get(b.id)!), `${a.id} ${b.id}`);
        }
      }
      for (const box of [...layout.nodes.values(), ...layout.groups.values()]) {
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height);
      }
      for (const [i, line] of layout.edges.entries()) assert.ok(line.length >= 2, `edge ${i} has a route`);
    }
  });
});

describe("comparing two graphs", () => {
  const diff: GraphDiff = diffGraphs(smallBase, small);

  it("lists what was added, removed and changed, nodes and references", () => {
    assert.deepEqual(diff.nodes.added.map((n) => n.type), ["aws_security_group"]);
    assert.deepEqual(diff.nodes.removed.map((n) => n.id), ["i-0old999"]);
    assert.deepEqual(diff.nodes.changed.map((c) => [c.before.version, c.after.version]), [["5.12.0", "5.13.0"]]);
    assert.equal(diff.edges.added.length, 3);
    assert.equal(diff.edges.removed.length, 1);
  });

  it("is empty for a graph against itself, whatever order it is written in", () => {
    const none = diffGraphs(medium, shuffled(medium, 4));
    assert.deepEqual(none, { nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [] } });
  });

  it("does not count glue as a change unless asked to", () => {
    const withoutGlue = { ...medium, nodes: medium.nodes.filter((n) => n.type !== "random_id"), edges: [] };
    const base = { ...medium, edges: [] };
    assert.deepEqual(diffGraphs(withoutGlue, base).nodes.added, []);
    assert.equal(diffGraphs(withoutGlue, base, { glue: false }).nodes.added.length, 1);
  });

  it("marks the view: statuses on nodes, boxes and lines, and counts", () => {
    const v = view(small, { base: smallBase });
    assert.equal(v.compared, true);
    assert.deepEqual(v.changes, { nodesAdded: 1, nodesRemoved: 1, nodesChanged: 1, edgesAdded: 3, edgesRemoved: 1 });
    assert.equal(v.nodes.find((n) => n.type === "aws_security_group")?.status, "added");
    assert.equal(v.nodes.find((n) => n.label === "i-0old999")?.status, "removed");
    assert.equal(v.groups.find((g) => g.kind === "module")?.status, "changed");
    assert.ok(v.edges.some((e) => e.status === "removed"));
    assert.ok(view(small).nodes.every((n) => n.status === "unchanged"));
  });

  it("in delta mode draws the changes and one reference of context, and nothing else", () => {
    const v = view(small, { base: smallBase, delta: true });
    assert.equal(v.mode, "delta");
    assert.deepEqual(
      Object.fromEntries(v.nodes.map((n) => [`${n.type} ${n.label}`, n.status])),
      {
        "aws_instance i-0abc123def456": "context",
        "aws_instance i-0old999": "removed",
        "aws_security_group sg-0123abcd": "added",
        "aws_subnet subnet-0f1e2d3c": "context",
        "aws_vpc vpc-0a1b2c3d": "context",
        "module call terraform-aws-modules/vpc/aws": "changed",
      },
    );
    assert.ok(v.edges.every((e) => e.status !== "unchanged" || v.nodes.find((n) => n.id === e.from)?.status !== "context" || v.nodes.find((n) => n.id === e.to)?.status !== "context"));
  });

  it("in delta mode leaves out a medium estate's untouched resources, and says nothing changed when so", () => {
    const base = { ...medium, nodes: medium.nodes.filter((n) => n.id !== "i-0web2"), edges: [] as GraphDocument["edges"] };
    const baseIndex = new Map(medium.nodes.map((n, i) => [i, base.nodes.indexOf(n)]));
    base.edges = medium.edges.flatMap((e) => {
      const from = baseIndex.get(e.from) as number;
      const to = baseIndex.get(e.to) as number;
      return from >= 0 && to >= 0 ? [{ from, to }] : [];
    });
    base.nodes = base.nodes.map((n) => (n.parent === undefined ? n : { ...n, parent: baseIndex.get(n.parent) as number }));
    const v = view(medium, { base, delta: true });
    assert.ok(v.nodes.length < view(medium).nodes.length / 2, `${v.nodes.length} nodes`);
    assert.equal(v.nodes.filter((n) => n.status === "added").length, 1);

    const same = view(medium, { base: medium, delta: true });
    assert.equal(same.nodes.length, 0);
    assert.match(renderGraphSvg(same), /No changes\./);
    assert.match(renderGraphMermaid(same), /No changes\./);
  });

  it("refuses a delta without a base", () => {
    assert.throws(() => view(small, { delta: true }), /needs a base/);
  });
});

describe("findings", () => {
  it("knows five severities, worst first", () => {
    const order: readonly Severity[] = SEVERITIES;
    assert.deepEqual(order, ["critical", "high", "medium", "low", "info"]);
  });

  const roleFinding: GraphFinding = { severity: "high", title: "wildcard", type: "aws_iam_role", id: "web-role" };

  it("places a finding on the resource that has its type and ID, and counts by severity", () => {
    const v = view(small, { findings: [roleFinding, { ...roleFinding, severity: "low", title: "tags" }] });
    const role = v.nodes.find((n) => n.type === "aws_iam_role");
    assert.deepEqual(role?.findings, { count: 2, worst: "high", bySeverity: { high: 1, low: 1 } });
    assert.deepEqual(v.findings, { total: 2, unplaced: 0, bySeverity: { high: 1, low: 1 } });
    assert.equal(v.nodes.filter((n) => n.findings).length, 1);
  });

  it("places an account's findings on its scope, which is where infraharvest's gate findings land", () => {
    const v = view(medium, { findings: [{ severity: "medium", title: "G5 scanners", account: "210987654321" }] });
    assert.equal(v.groups.find((g) => g.label.endsWith("210987654321"))?.findings?.count, 1);
    assert.equal(v.groups.find((g) => g.label.endsWith("123456789012"))?.findings, null);
  });

  it("rolls a finding on a hidden resource up to the module call or scope it is in", () => {
    const v = view(medium, { findings: [{ severity: "high", title: "x", type: "aws_iam_role_policy_attachment", id: "app-role/app" }] });
    assert.equal(v.groups.find((g) => g.label.endsWith("123456789012"))?.findings?.count, 1);
    assert.equal(v.findings?.unplaced, 0);
  });

  it("counts, and does not guess at, a finding it cannot place", () => {
    const v = view(small, {
      findings: [
        { severity: "high", title: "by address", address: "aws_iam_role.web" },
        { severity: "low", title: "no such resource", type: "aws_vpc", id: "vpc-nope" },
        { severity: "low", title: "no such account", account: "000000000000" },
        roleFinding,
      ],
    });
    assert.deepEqual(v.findings, { total: 4, unplaced: 3, bySeverity: { high: 1 } });
    assert.match(renderGraphSvg(v), /Findings: 1 placed \(1 high\), 3 not placed\./);
  });

  it("places an address when the caller can turn it into a type and ID", () => {
    const v = view(small, {
      findings: [{ severity: "high", title: "by address", address: "aws_iam_role.web" }],
      resolveAddress: (address) => (address === "aws_iam_role.web" ? { type: "aws_iam_role", id: "web-role" } : undefined),
    });
    assert.equal(v.nodes.find((n) => n.type === "aws_iam_role")?.findings?.count, 1);
  });

  it("matches the account when the finding names one, so the same ID in another account is left alone", () => {
    const v = view(medium, { findings: [{ severity: "low", title: "x", type: "aws_vpc", id: "vpc-0a1b2c3d", account: "210987654321" }] });
    assert.equal(v.findings?.unplaced, 1);
  });

  it("draws a marker with the count, in the severity's colour, with the breakdown in its title", () => {
    const svg = renderGraphSvg(view(small, { findings: [roleFinding, { ...roleFinding, severity: "critical", title: "worse" }] }));
    assert.match(svg, /<title>2 findings: 1 critical, 1 high<\/title><rect[^>]*fill="#7f1d1d"/);
    const mermaid = renderGraphMermaid(view(small, { findings: [roleFinding] }));
    assert.match(mermaid, /web-role \[1 high\]/);
    assert.match(mermaid, /classDef high /);
  });

  it("reads infraharvest's OCSF findings: one per failed check, on the root's account", () => {
    const ocsf = {
      schema: "infraharvest/ocsf-findings/v1",
      run_id: "6f1c9d3e-0a52-5b8e-9c47-2d1f3a5b7c90",
      events: [
        { severity: "High", message: "G6 secrets failed", finding_info: { title: "G6 secrets", types: ["secrets_found"] }, cloud: { provider: "AWS", account: { uid: "123456789012" }, region: "eu-west-1" } },
        { severity: "Low", message: "G1 format skipped", finding_info: { title: "G1 format", types: [] } },
      ],
    };
    assert.deepEqual(findingsFromOcsf(ocsf), [
      { severity: "high", title: "G6 secrets (secrets_found)", account: "123456789012", region: "eu-west-1" },
      { severity: "low", title: "G1 format" },
    ]);
    assert.deepEqual(parseFindings(JSON.stringify(ocsf)), findingsFromOcsf(ocsf));
    assert.equal(view(small, { findings: findingsFromOcsf(ocsf) }).findings?.unplaced, 1);
  });

  it("reads a review's findings, from a findings list or Infraweaver's introduced_findings", () => {
    const list = { findings: [{ severity: "medium", rule_id: "CKV_AWS_1", resource: "aws_s3_bucket.logs" }, { severity: "info", title: "note", type: "aws_vpc", id: "vpc-1", account: "1" }] };
    assert.deepEqual(findingsFromReview(list), [
      { severity: "medium", title: "CKV_AWS_1", address: "aws_s3_bucket.logs" },
      { severity: "info", title: "note", type: "aws_vpc", id: "vpc-1", account: "1" },
    ]);
    assert.deepEqual(parseFindings({ introduced_findings: list.findings }), findingsFromReview(list));
    assert.deepEqual(findingsFromReview({}), []);
  });

  it("refuses findings it cannot read", () => {
    assert.throws(() => parseFindings({ findings: [{ severity: "urgent", title: "x" }] }), /not a findings document/);
    assert.throws(() => parseFindings({ schema: "infraharvest/ocsf-findings/v1", events: [{}] }), GraphDocumentError);
    assert.throws(() => parseFindings("nope"), /not valid JSON/);
  });
});

describe("goldens", () => {
  it("draws the small estate", () => {
    golden("small.svg", `${renderGraphSvg(view(small, { title: "web tier" }))}\n`);
    golden("small.mmd", renderGraphMermaid(view(small, { title: "web tier" })));
  });

  it("draws the medium estate", () => {
    golden("medium.svg", `${renderGraphSvg(view(medium))}\n`);
    golden("medium.mmd", renderGraphMermaid(view(medium)));
  });

  it("draws what changed between two small estates, in full and as a delta", () => {
    golden("small-diff.svg", `${renderGraphSvg(view(small, { base: smallBase }))}\n`);
    golden("small-diff.mmd", renderGraphMermaid(view(small, { base: smallBase })));
    golden("small-delta.svg", `${renderGraphSvg(view(small, { base: smallBase, delta: true }))}\n`);
    golden("small-delta.mmd", renderGraphMermaid(view(small, { base: smallBase, delta: true })));
  });

  it("draws the medium estate with findings over it", () => {
    const findings: GraphFinding[] = [
      { severity: "high", title: "open ingress", type: "aws_security_group", id: "sg-0web" },
      { severity: "medium", title: "no encryption", type: "aws_db_instance", id: "db-main" },
      { severity: "low", title: "no tags", type: "aws_instance", id: "i-0web1" },
      { severity: "low", title: "no tags", type: "aws_instance", id: "i-0web1" },
      { severity: "critical", title: "G6 secrets", account: "210987654321" },
      { severity: "info", title: "by address", address: "aws_s3_bucket.logs" },
    ];
    golden("medium-findings.svg", `${renderGraphSvg(view(medium, { findings }))}\n`);
  });
});
