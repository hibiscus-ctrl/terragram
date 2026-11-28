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
  renderGraphDrawio,
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
const large = load("large");
const azure = load("azure");
const gcp = load("gcp");
const environments = load("environments");
const environmentsBase = load("environments-base");
const devProd = load("dev-prod");
const hashedDevProd = load("hashed");

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
    ["environments and addresses", mutate((d) => { node(d, 0).environment = "prod"; node(d, 0).module_address = "module.network"; node(d, 1).environment = "prod"; node(d, 1).address = "module.network.aws_vpc.this"; d.redaction = { ids_hashed: false, hash_alg: "hmac-sha256", addresses: "plain" }; }), true],
    ["hashed addresses", mutate((d) => { node(d, 1).address = "4f2a9c"; d.redaction = { ids_hashed: true, hash_alg: "hmac-sha256", addresses: "hashed" }; }), true],
    ["an address way that is not plain, hashed or dropped", mutate((d) => { d.redaction = { ids_hashed: false, hash_alg: "hmac-sha256", addresses: "masked" }; }), false],
    ["an empty environment", mutate((d) => { node(d, 1).environment = ""; }), false],
    ["a root on a resource and on a module call", mutate((d) => { node(d, 0).root = "aws/123456789012/eu-west-1"; node(d, 1).root = "aws/123456789012/eu-west-1"; }), true],
    ["a hashed root", mutate((d) => { node(d, 1).root = "4f2a9c"; d.redaction = { ids_hashed: true, hash_alg: "hmac-sha256", addresses: "hashed" }; }), true],
    ["an empty root", mutate((d) => { node(d, 1).root = ""; }), false],
    ["a resource with a module address", mutate((d) => { node(d, 1).module_address = "module.network"; }), false],
    ["a module with a resource address", mutate((d) => { node(d, 0).address = "aws_vpc.this"; }), false],
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

  it("carries the environment a graph names onto its cards, and nothing when it names none", () => {
    const named = { ...small, nodes: small.nodes.map((n) => ({ ...n, environment: "prod" })) };
    assert.ok(view(named).nodes.every((n) => n.environment === "prod"));
    assert.ok(view(small).nodes.every((n) => n.environment === undefined));
  });

  it("shortens an ID to what fits a card, and a hashed one to its first characters", () => {
    const long = { ...small, nodes: small.nodes.map((n) => (n.id === "i-0abc123def456" ? { ...n, id: `${"x".repeat(40)}/last-part` } : n)) };
    assert.ok(view(long).nodes.some((n) => n.label === "last-part"));
    const hashed = { ...small, redaction: { ids_hashed: true, hash_alg: "hmac-sha256" as const }, nodes: small.nodes.map((n) => (n.id === "web-role" ? { ...n, id: "f".repeat(64) } : n)) };
    assert.ok(view(hashed).nodes.some((n) => n.label === "ffffffff"));
  });
});

describe("environments", () => {
  const groupsOf = (v: GraphView, kind: ViewGroup["kind"]) => v.groups.filter((g) => g.kind === kind);
  const byLabel = (v: GraphView, label: string) => v.groups.find((g) => g.label === label);

  it("nests a scope, then an environment, then a module call, then the resources", () => {
    const v = view(environments);
    const [scope, other] = scopes(v);
    assert.equal(scopes(v).length, 2);
    assert.equal(other?.label, "AWS account 210987654321");
    const prod = byLabel(v, "environment prod");
    const staging = byLabel(v, "environment staging");
    const dev = byLabel(v, "environment dev");
    assert.equal(prod?.parent, scope?.id);
    assert.equal(staging?.parent, scope?.id);
    assert.equal(dev?.parent, other?.id);
    assert.deepEqual(groupsOf(v, "environment").map((g) => g.label), ["environment prod", "environment staging", "environment dev"]);
    const module = groupsOf(v, "module")[0];
    assert.equal(module?.parent, prod?.id, "a module call sits in its root's environment");
    assert.equal(nodeOf(v, "aws_vpc")?.group, module?.id, "a resource of a module call is in its box");
    assert.equal(nodeOf(v, "aws_s3_bucket")?.group, staging?.id);
    assert.equal(v.nodes.find((n) => n.label === "i-0dev1")?.group, dev?.id);
    assert.equal(nodeOf(v, "aws_iam_role")?.group, scope?.id, "a resource with no environment sits in its scope");
  });

  it("draws an environment box in both formats, and none for a graph that names no environment", () => {
    const v = view(environments);
    const svg = renderGraphSvg(v);
    assert.match(svg, />environment prod</);
    assert.match(svg, />environment staging</);
    const mermaid = renderGraphMermaid(v);
    assert.match(mermaid, /subgraph g\d+\["environment prod"\]\n\s+subgraph g\d+\["module terraform-aws-modules\/vpc\/aws 5\.13\.0"\]/);
    for (const doc of [small, medium]) {
      assert.deepEqual(groupsOf(view(doc), "environment"), []);
      assert.doesNotMatch(renderGraphSvg(view(doc)), /environment/);
      assert.doesNotMatch(renderGraphMermaid(view(doc)), /environment/);
    }
  });

  it("draws every environment box around its members, inside its scope", () => {
    const v = view(environments);
    const layout = layoutGraph(v);
    for (const group of v.groups.filter((g) => g.parent !== null)) {
      const box = layout.groups.get(group.id);
      const outer = layout.groups.get(group.parent ?? "");
      assert.ok(box && outer, group.label);
      assert.ok(box.x >= outer.x && box.y >= outer.y && box.x + box.width <= outer.x + outer.width && box.y + box.height <= outer.y + outer.height, group.label);
    }
  });

  it("does not depend on the order the document lists its nodes in", () => {
    for (const seed of [1, 2, 3]) {
      const other = shuffled(environments, seed);
      assert.notDeepEqual(other.nodes, environments.nodes, "the shuffle should move something");
      assert.equal(renderGraphSvg(view(other)), renderGraphSvg(view(environments)));
      assert.equal(renderGraphMermaid(view(other)), renderGraphMermaid(view(environments)));
    }
  });

  it("shows a root that moved to another environment as a change", () => {
    const diff = diffGraphs(environmentsBase, environments);
    assert.deepEqual(diff.nodes.changed.map((c) => [c.before.environment, c.after.environment]), [["prod", "staging"]]);
    const v = view(environments, { base: environmentsBase });
    assert.equal(nodeOf(v, "aws_s3_bucket")?.status, "changed");
    assert.equal(v.changes?.nodesChanged, 1);
    assert.equal(v.changes?.nodesAdded, 1);
    // The same graph against itself changes nothing, whatever its addresses say.
    assert.equal(diffGraphs(environments, environments).nodes.changed.length, 0);
    const rehashed = { ...environments, nodes: environments.nodes.map((n) => (n.address ? { ...n, address: `h-${n.address}` } : n)) };
    assert.equal(diffGraphs(environments, rehashed).nodes.changed.length, 0);
  });
});

/** The document without the nodes `drop` names, the edges that ended at them gone and the indexes remapped. */
function without(doc: GraphDocument, drop: (node: GraphDocument["nodes"][number]) => boolean): GraphDocument {
  const keep = doc.nodes.map((n, i) => (drop(n) ? -1 : i)).filter((i) => i >= 0);
  const at = new Map(keep.map((old, i) => [old, i]));
  const nodes = keep.map((old) => {
    const node = structuredClone(doc.nodes[old] as GraphDocument["nodes"][number]);
    if (node.parent !== undefined) node.parent = at.get(node.parent) as number;
    return node;
  });
  const edges = doc.edges.flatMap((e) => (at.has(e.from) && at.has(e.to) ? [{ from: at.get(e.from) as number, to: at.get(e.to) as number }] : []));
  return { ...doc, nodes, edges };
}

/** What `infraharvest export --drop-addresses` leaves of a document: no addresses and no roots. */
function dropAddresses(doc: GraphDocument): GraphDocument {
  return {
    ...doc,
    nodes: doc.nodes.map(({ address: _address, module_address: _module, root: _root, ...rest }) => rest),
    redaction: { ...doc.redaction, addresses: "dropped" },
  };
}

describe("placement", () => {
  const groupsOf = (v: GraphView, kind: ViewGroup["kind"]) => v.groups.filter((g) => g.kind === kind);
  const byLabel = (v: GraphView, label: string) => v.groups.find((g) => g.label === label);
  /** `type label` of the cards in a box, in the order they are drawn. */
  const cardsIn = (v: GraphView, group: ViewGroup | undefined) => v.nodes.filter((n) => n.group === group?.id).map((n) => `${n.type} ${n.label}`);

  it("nests one scope, then dev and prod by name, then each environment's module call", () => {
    const v = view(devProd);
    const [scope] = scopes(v);
    assert.deepEqual(scopes(v).map((g) => g.label), ["AWS account 123456789012"]);
    assert.deepEqual(groupsOf(v, "environment").map((g) => g.label), ["environment dev", "environment prod"], "by name, though the document lists prod first");
    assert.deepEqual(groupsOf(v, "environment").map((g) => g.parent), [scope?.id, scope?.id]);
    assert.deepEqual(groupsOf(v, "module").map((g) => g.parent), groupsOf(v, "environment").map((g) => g.id));
    assert.ok(v.nodes.every((n) => n.group !== ""));
  });

  it("places a card among its neighbours by module path, then Terraform address", () => {
    const v = view(devProd);
    // The resources of no module call first, by address, then the module call's own: never by type or ID alone.
    assert.deepEqual(cardsIn(v, byLabel(v, "environment dev")), [
      "aws_db_instance db-dev",
      "aws_ecr_repository app-images",
      "aws_ecs_service svc-dev",
      "aws_iam_role app-role-dev",
      "aws_security_group sg-dev",
    ]);
    assert.deepEqual(cardsIn(v, groupsOf(v, "module")[1]), ["aws_subnet subnet-prod", "aws_vpc vpc-prod"], "the module call has a card only when a line ends at it");
    // The ids follow the order: dev's cards are numbered before prod's.
    assert.deepEqual(v.nodes.map((n) => n.id), v.nodes.map((_, i) => `n${i}`));
    assert.ok(v.nodes.findIndex((n) => n.label === "db-dev") < v.nodes.findIndex((n) => n.label === "db-prod"));
  });

  it("orders by address when the graph keeps addresses, and by key when it does not", () => {
    const ordered = (doc: GraphDocument) => view(doc).nodes.map((n) => n.label);
    const pair = (addresses: "plain" | "hashed"): GraphDocument => ({
      ...small,
      redaction: { ...small.redaction, addresses },
      nodes: [
        { kind: "resource", type: "aws_instance", id: "i-aaa", account: "123456789012", environment: "prod", address: "aws_instance.zebra" },
        { kind: "resource", type: "aws_instance", id: "i-zzz", account: "123456789012", environment: "prod", address: "aws_instance.apple" },
      ],
      edges: [],
    });
    assert.deepEqual(ordered(pair("plain")), ["i-zzz", "i-aaa"], "apple before zebra, though its ID sorts after");
    // A hashed address says nothing about order and a dropped one is gone: the key (type, then ID) decides, as it did before addresses.
    assert.deepEqual(ordered(pair("hashed")), ["i-aaa", "i-zzz"]);
    assert.deepEqual(ordered(dropAddresses(pair("plain"))), ["i-aaa", "i-zzz"]);
    const bare = pair("plain");
    bare.nodes = bare.nodes.map(({ address: _address, ...rest }) => rest);
    assert.deepEqual(ordered(bare), ["i-aaa", "i-zzz"], "a graph that predates addresses");
  });

  it("tells the same address in two roots apart by the roots' order", () => {
    const doc = structuredClone(devProd);
    const web = doc.nodes.find((n) => n.id === "svc-prod");
    assert.ok(web);
    // Listed in the order that is neither the roots' nor the IDs'.
    doc.nodes.push({ ...web, id: "svc-a", root: "aws/123456789012/prod-b" }, { ...web, id: "svc-b", root: "aws/123456789012/prod-a" });
    const labels = view(doc).nodes.filter((n) => n.type === "aws_ecs_service" && n.environment === "prod").map((n) => n.label);
    assert.deepEqual(labels, ["svc-prod", "svc-b", "svc-a"], "roots: .../prod, .../prod-a, .../prod-b");
  });

  it("puts what names no environment directly in its scope, with no group of its own", () => {
    const mixed = structuredClone(devProd);
    const loose = mixed.nodes.find((n) => n.id === "app-images");
    assert.ok(loose);
    delete loose.environment;
    delete loose.root;
    const v = view(mixed);
    assert.deepEqual(groupsOf(v, "environment").map((g) => g.label), ["environment dev", "environment prod"]);
    assert.equal(v.nodes.find((n) => n.label === "app-images")?.group, scopes(v)[0]?.id);
    assert.doesNotMatch(renderGraphSvg(v), /unassigned/i);
    assert.doesNotMatch(renderGraphMermaid(v), /unassigned/i);
  });

  it("keeps a reference that crosses environments, as a routed line and as an arrow", () => {
    const v = view(devProd);
    const ecr = v.nodes.find((n) => n.label === "app-images");
    const prodService = v.nodes.find((n) => n.label === "svc-prod");
    const devService = v.nodes.find((n) => n.label === "svc-dev");
    assert.ok(ecr && prodService && devService);
    assert.notEqual(prodService.group, ecr.group, "the two sit in different environments");
    assert.ok(v.edges.some((e) => e.from === prodService.id && e.to === ecr.id));
    assert.ok(v.edges.some((e) => e.from === devService.id && e.to === ecr.id));
    assert.match(renderGraphMermaid(v), new RegExp(`^  ${prodService.id} --> ${ecr.id}$`, "m"));
    const layout = layoutGraph(v);
    for (const [i, edge] of v.edges.entries()) assert.ok((layout.edges[i] ?? []).length >= 2, `${edge.from} -> ${edge.to} is routed`);
    const svg = renderGraphSvg(v);
    assert.equal(svg.split('marker-end="url(#tg-arrow-').length - 1, v.edges.length);
  });

  it("hides glue, and joins the line through it, as it does without environments", () => {
    const v = view(devProd);
    assert.equal(v.hidden.count, 2);
    assert.deepEqual(v.hidden.types, [{ type: "aws_iam_role_policy_attachment", count: 2 }]);
    assert.ok(v.nodes.every((n) => n.type !== "aws_iam_role_policy_attachment"));
  });

  it("renders a hashed or dropped graph, grouped by environment, in the same bytes from any order", () => {
    for (const doc of [hashedDevProd, dropAddresses(devProd), dropAddresses(hashedDevProd)]) {
      const v = view(doc);
      assert.deepEqual(groupsOf(v, "environment").map((g) => g.label), ["environment dev", "environment prod"]);
      assert.equal(v.nodes.length, 13);
      const svg = renderGraphSvg(v);
      const mermaid = renderGraphMermaid(v);
      for (const seed of [1, 2, 3]) {
        assert.equal(renderGraphSvg(view(shuffled(doc, seed))), svg);
        assert.equal(renderGraphMermaid(view(shuffled(doc, seed))), mermaid);
      }
    }
    assert.match(view(hashedDevProd).nodes[0]?.label ?? "", /^[0-9a-f]{8}$/);
  });

  it("gives the same picture from any order of nodes and edges, with and without a base", () => {
    const base = without(devProd, (n) => n.id === "db-prod");
    const full = [renderGraphSvg(view(devProd)), renderGraphMermaid(view(devProd)), JSON.stringify(view(devProd))];
    const delta = [renderGraphSvg(view(devProd, { base, delta: true })), renderGraphMermaid(view(devProd, { base, delta: true }))];
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const other = shuffled(devProd, seed);
      assert.notDeepEqual(other.nodes, devProd.nodes, "the shuffle should move something");
      assert.deepEqual([renderGraphSvg(view(other)), renderGraphMermaid(view(other)), JSON.stringify(view(other))], full, `seed ${seed}`);
      const again = view(other, { base: shuffled(base, seed + 10), delta: true });
      assert.deepEqual([renderGraphSvg(again), renderGraphMermaid(again)], delta, `delta, seed ${seed}`);
    }
  });

  it("shows only what changed in a delta, with the boxes it sits in", () => {
    const base = without(devProd, (n) => n.id === "db-prod");
    const v = view(devProd, { base, delta: true });
    assert.equal(v.mode, "delta");
    // The added database, and what it refers to or is referred by, one reference away.
    assert.deepEqual(v.nodes.map((n) => `${n.status} ${n.label}`).sort(), ["added db-prod", "context subnet-prod", "context svc-prod"]);
    assert.deepEqual(v.groups.map((g) => g.label), ["AWS account 123456789012", "environment prod", "module terraform-aws-modules/vpc/aws"]);
    assert.equal(v.groups.find((g) => g.kind === "environment")?.parent, v.groups[0]?.id);
  });
});

describe("roots", () => {
  const eu1 = "aws/123456789012/eu-west-1";
  const eu2 = "aws/123456789012/eu-west-2";
  // The prod roots of one environment in two regions, each with a web server at the same address.
  const withRoots = (): GraphDocument => {
    const doc = structuredClone(environments);
    const web = doc.nodes.find((n) => n.address === "aws_instance.web" && n.environment === "prod");
    assert.ok(web);
    doc.nodes = doc.nodes.map((n) => (n.environment === "prod" ? { ...n, root: eu1 } : n));
    doc.nodes.push({ ...web, region: "eu-west-2", id: "i-0web2", root: eu2 });
    return doc;
  };
  const roots = withRoots();
  const place = (finding: Omit<GraphFinding, "severity" | "title">, doc: GraphDocument = roots) =>
    view(doc, { findings: [{ severity: "high", title: "x", ...finding }] });
  const countOn = (v: GraphView, id: string) => v.nodes.find((n) => n.label === id)?.findings?.count;

  it("tells the same address in two roots of one environment apart, when the finding names the root", () => {
    const both = place({ address: "aws_instance.web", account: "123456789012", environment: "prod" });
    assert.equal(both.findings?.unplaced, 1, "two roots of the environment have it");
    const second = place({ address: "aws_instance.web", account: "123456789012", environment: "prod", root: eu2 });
    assert.equal(countOn(second, "i-0web2"), 1);
    assert.equal(countOn(second, "i-0web1"), undefined);
    assert.equal(second.findings?.unplaced, 0);
    assert.equal(countOn(place({ address: "aws_instance.web", environment: "prod", root: eu1 }), "i-0web1"), 1);
    assert.equal(place({ address: "aws_instance.web", environment: "prod", root: "aws/other" }).findings?.unplaced, 1);
  });

  it("narrows a finding with a type and ID by root", () => {
    assert.equal(place({ type: "aws_instance", id: "i-0web1", root: eu2 }).findings?.unplaced, 1);
    assert.equal(countOn(place({ type: "aws_instance", id: "i-0web1", root: eu1 }), "i-0web1"), 1);
  });

  it("places a finding that names no root as it did before, when the graph names none", () => {
    assert.equal(countOn(place({ address: "aws_instance.web", environment: "staging" }, environments), "i-0stg1"), 1);
    assert.equal(place({ address: "aws_instance.web", environment: "prod", root: eu1 }, environments).findings?.unplaced, 1, "no node has a root to match");
  });

  it("keeps a resource that two roots list at the same type and ID as two nodes, in any order", () => {
    const twice = (doc: GraphDocument): GraphDocument => ({ ...doc, nodes: doc.nodes.map((n) => (n.id === "i-0web2" ? { ...n, id: "i-0web1", region: "eu-west-1" } : n)) });
    const doc = twice(roots);
    const key = (d: GraphDocument) => view(d).nodes.filter((n) => n.label === "i-0web1").length;
    assert.equal(key(doc), 2);
    const other = shuffled(doc, 7);
    assert.equal(renderGraphSvg(view(other)), renderGraphSvg(view(doc)));
    const placed = place({ address: "aws_instance.web", environment: "prod", root: eu2 }, doc);
    assert.equal(placed.nodes.filter((n) => n.findings).length, 1);
  });

  it("shows a node that moved to another root as a change, and a graph that gains roots as none", () => {
    const moved = { ...roots, nodes: roots.nodes.map((n) => (n.id === "i-0web1" ? { ...n, root: eu2 } : n)) };
    const diff = diffGraphs(roots, moved);
    assert.deepEqual(diff.nodes.changed.map((c) => [c.before.root, c.after.root]), [[eu1, eu2]]);
    assert.equal(view(moved, { base: roots }).nodes.find((n) => n.label === "i-0web1")?.status, "changed");
    assert.equal(diffGraphs(environments, roots).nodes.changed.length, 0, "a base from before roots is not a move");
    assert.equal(diffGraphs(roots, environments).nodes.changed.length, 0);
    assert.equal(diffGraphs(roots, roots).nodes.changed.length, 0);
  });

  it("compares roots only when both graphs keep them plain", () => {
    const hash = (doc: GraphDocument, key: string): GraphDocument => ({
      ...doc,
      redaction: { ...doc.redaction, addresses: "hashed" },
      nodes: doc.nodes.map((n) => ({
        ...n,
        ...(n.address !== undefined && { address: `${key}${n.address}` }),
        ...(n.root !== undefined && { root: `${key}${n.root}` }),
      })),
    });
    const moved = { ...roots, nodes: roots.nodes.map((n) => (n.id === "i-0web1" ? { ...n, root: eu2 } : n)) };
    assert.equal(diffGraphs(roots, moved).nodes.changed.length, 1, "plain against plain, with a real move");
    assert.equal(diffGraphs(roots, hash(roots, "aa")).nodes.changed.length, 0, "plain against hashed");
    assert.equal(diffGraphs(hash(roots, "aa"), roots).nodes.changed.length, 0, "hashed against plain");
    assert.equal(diffGraphs(hash(roots, "aa"), hash(roots, "bb")).nodes.changed.length, 0, "a rotated hash key");
    assert.equal(diffGraphs(hash(roots, "aa"), hash(moved, "aa")).nodes.changed.length, 0, "hashed against hashed cannot be compared");
    const dropped: GraphDocument = { ...roots, redaction: { ...roots.redaction, addresses: "dropped" }, nodes: roots.nodes.map(({ root: _root, ...n }) => n) };
    assert.equal(diffGraphs(roots, dropped).nodes.changed.length, 0, "dropped roots");
  });

  it("never writes a hostile root unescaped into the SVG or Mermaid", () => {
    const hostile = "\"><script>alert(1)</script>'`\nroot";
    const withRoot = (root: string): GraphDocument => ({ ...roots, nodes: roots.nodes.map((n) => (n.root === undefined ? n : { ...n, root })) });
    const doc = withRoot(hostile);
    const finding = { severity: "high" as const, title: "x", address: "aws_instance.web", environment: "prod", root: hostile };
    for (const v of [view(doc), view(doc, { base: withRoot("aws/other") }), view(withRoot("aws/other"), { base: doc }), view(doc, { findings: [finding] })]) {
      for (const out of [renderGraphSvg(v), renderGraphMermaid(v)]) {
        assert.ok(!out.includes("<script"), "no script element");
        assert.ok(!out.includes("alert(1)"), "no part of the root is written out");
      }
    }
  });

  it("draws a graph without roots as before", () => {
    const stripped = { ...roots, nodes: roots.nodes.map(({ root: _root, ...n }) => n).filter((n) => n.id !== "i-0web2") };
    assert.equal(renderGraphSvg(view(stripped)), renderGraphSvg(view(environments)));
    assert.equal(renderGraphMermaid(view(stripped)), renderGraphMermaid(view(environments)));
  });

  it("reads the root from a review's findings", () => {
    assert.deepEqual(findingsFromReview({ findings: [{ severity: "low", title: "t", resource: "aws_instance.web", environment: "prod", root: eu2 }] }), [
      { severity: "low", title: "t", environment: "prod", root: eu2, address: "aws_instance.web" },
    ]);
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

  it("drops what XML 1.0 cannot hold (U+FFFE, U+FFFF, lone surrogates) and keeps real astral characters", () => {
    const odd = `a￿b￾c\uD800d\uDC00e😀`;
    const doc = { ...small, nodes: small.nodes.map((n) => (n.id === "web-role" ? { ...n, id: odd } : n)) };
    const svg = renderGraphSvg(view(doc, { title: odd }));
    assert.ok(!/[￾￿]/.test(svg));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(svg));
    assert.ok(svg.includes("abcde😀"));
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

  describe("by the graph's own addresses", () => {
    const place = (finding: Omit<GraphFinding, "severity" | "title">, options: ProjectOptions = {}) =>
      view(environments, { findings: [{ severity: "high", title: "x", ...finding }], ...options });
    const countOn = (v: GraphView, id: string) => v.nodes.find((n) => n.label === id)?.findings?.count;

    it("places a finding on the one resource that has the address, with no resolver", () => {
      const v = place({ address: "aws_iam_role.web" });
      assert.equal(countOn(v, "web-role"), 1);
      assert.deepEqual(v.findings, { total: 1, unplaced: 0, bySeverity: { high: 1 } });
      assert.equal(countOn(place({ address: "module.network.aws_vpc.this" }), "vpc-0a1b2c3d"), 1);
      assert.equal(countOn(place({ address: "aws_s3_bucket.logs" }), "logs-bucket"), 1);
    });

    it("places a finding on a module call's box by its module address", () => {
      const v = place({ address: "module.network" });
      const box = v.groups.find((g) => g.kind === "module");
      assert.equal(box?.findings?.count, 1);
      assert.equal(v.findings?.unplaced, 0);
    });

    it("leaves an address that every root has unplaced, unless the finding names the root", () => {
      assert.equal(place({ address: "aws_instance.web" }).findings?.unplaced, 1, "three roots have it");
      // Two roots of the account have it: the finding names a resource that cannot be told apart, so it is not
      // moved to the account's scope, where it would read as an account-wide finding.
      const inAccount = place({ address: "aws_instance.web", account: "123456789012" });
      assert.equal(inAccount.nodes.filter((n) => n.findings).length, 0, "two roots in the account have it, so no card is chosen");
      assert.equal(scopes(inAccount)[0]?.findings?.count, undefined);
      assert.deepEqual(inAccount.findings, { total: 1, unplaced: 1, bySeverity: {} });
      const prod = place({ address: "aws_instance.web", account: "123456789012", environment: "prod" });
      assert.equal(countOn(prod, "i-0web1"), 1);
      assert.equal(countOn(prod, "i-0stg1"), undefined);
      assert.equal(countOn(place({ address: "aws_instance.web", account: "210987654321" }), "i-0dev1"), 1);
      assert.equal(countOn(place({ address: "aws_instance.web", environment: "staging" }), "i-0stg1"), 1);
    });

    it("narrows a finding with a type and ID by environment too", () => {
      assert.equal(place({ type: "aws_instance", id: "i-0web1", environment: "staging" }).findings?.unplaced, 1);
      assert.equal(countOn(place({ type: "aws_instance", id: "i-0web1", environment: "prod" }), "i-0web1"), 1);
    });

    it("shows a finding on a hidden glue resource on its environment's box", () => {
      const v = place({ address: "aws_iam_role_policy_attachment.web" });
      assert.equal(v.findings?.unplaced, 0);
      assert.equal(v.groups.find((g) => g.label === "environment prod")?.findings?.count, 1);
    });

    it("does not place an address the graph does not keep, unless the caller resolves it", () => {
      const hashed = { ...environments, redaction: { ...environments.redaction, addresses: "hashed" as const }, nodes: environments.nodes.map((n) => (n.address ? { ...n, address: "4f2a9c" } : n)) };
      const finding = { severity: "high" as const, title: "x", address: "aws_iam_role.web" };
      assert.equal(view(hashed, { findings: [finding] }).findings?.unplaced, 1);
      const resolved = view(hashed, { findings: [finding], resolveAddress: () => ({ type: "aws_iam_role", id: "web-role" }) });
      assert.equal(resolved.findings?.unplaced, 0);
      const dropped = { ...hashed, nodes: environments.nodes.map(({ address: _address, ...n }) => n) };
      assert.equal(view(dropped, { findings: [finding] }).findings?.unplaced, 1);
    });

    it("lets the caller's resolver answer an address the graph also keeps only when the graph cannot", () => {
      const v = place({ address: "aws_instance.web" }, { resolveAddress: () => ({ type: "aws_instance", id: "i-0stg1" }) });
      assert.equal(countOn(v, "i-0stg1"), 1);
    });

    it("reads an environment from a review's findings", () => {
      assert.deepEqual(findingsFromReview({ findings: [{ severity: "low", title: "t", resource: "aws_instance.web", environment: "prod" }] }), [
        { severity: "low", title: "t", environment: "prod", address: "aws_instance.web" },
      ]);
    });
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
    golden("small.drawio", renderGraphDrawio(view(small, { title: "web tier" })));
  });

  it("draws a Google Cloud estate", () => {
    golden("gcp.svg", `${renderGraphSvg(view(gcp, { title: "orders" }))}\n`);
    golden("gcp.mmd", renderGraphMermaid(view(gcp, { title: "orders" })));
    golden("gcp.drawio", renderGraphDrawio(view(gcp, { title: "orders" })));
  });

  it("draws the medium estate", () => {
    golden("medium.svg", `${renderGraphSvg(view(medium))}\n`);
    golden("medium.mmd", renderGraphMermaid(view(medium)));
    golden("medium.drawio", renderGraphDrawio(view(medium)));
  });

  it("draws the large estate, 64 resources in four boxes, as wide as it is tall", () => {
    golden("large.svg", `${renderGraphSvg(view(large))}\n`);
    golden("large.drawio", renderGraphDrawio(view(large)));
    golden("large.mmd", renderGraphMermaid(view(large)));
  });

  it("draws the Azure estate, a subscription whose resources refer to each other, at the Services level as wide as it is tall", () => {
    golden("azure-services.svg", `${renderGraphSvg(view(azure, { level: "services" }))}\n`);
  });

  it("draws what changed between two small estates, in full and as a delta", () => {
    golden("small-diff.svg", `${renderGraphSvg(view(small, { base: smallBase }))}\n`);
    golden("small-diff.mmd", renderGraphMermaid(view(small, { base: smallBase })));
    golden("small-diff.drawio", renderGraphDrawio(view(small, { base: smallBase })));
    golden("small-delta.svg", `${renderGraphSvg(view(small, { base: smallBase, delta: true }))}\n`);
    golden("small-delta.mmd", renderGraphMermaid(view(small, { base: smallBase, delta: true })));
  });

  it("draws an estate with environments, and what changed in it, with findings over it", () => {
    const findings: GraphFinding[] = [
      { severity: "high", title: "open ingress", address: "aws_security_group.web", account: "123456789012", environment: "prod" },
      { severity: "medium", title: "no versioning", address: "aws_s3_bucket.logs" },
      { severity: "low", title: "old module", address: "module.network" },
      { severity: "info", title: "ambiguous", address: "aws_instance.web" },
    ];
    golden("environments.svg", `${renderGraphSvg(view(environments, { findings }))}\n`);
    golden("environments.mmd", renderGraphMermaid(view(environments, { findings })));
    golden("environments.drawio", renderGraphDrawio(view(environments, { findings })));
    golden("environments-diff.svg", `${renderGraphSvg(view(environments, { base: environmentsBase }))}\n`);
    golden("environments-diff.mmd", renderGraphMermaid(view(environments, { base: environmentsBase })));
  });

  it("draws two environments of one account, in full and as a delta", () => {
    const base = without(devProd, (n) => n.id === "db-prod");
    golden("dev-prod.svg", `${renderGraphSvg(view(devProd, { title: "dev and prod" }))}\n`);
    golden("dev-prod.mmd", renderGraphMermaid(view(devProd, { title: "dev and prod" })));
    golden("dev-prod.drawio", renderGraphDrawio(view(devProd, { title: "dev and prod" })));
    golden("dev-prod-delta.svg", `${renderGraphSvg(view(devProd, { base, delta: true }))}\n`);
    golden("dev-prod-delta.mmd", renderGraphMermaid(view(devProd, { base, delta: true })));
    golden("dev-prod-delta.drawio", renderGraphDrawio(view(devProd, { base, delta: true })));
  });

  it("draws the same estate with its IDs and addresses hashed, and with its addresses dropped", () => {
    golden("hashed.svg", `${renderGraphSvg(view(hashedDevProd))}\n`);
    golden("hashed.mmd", renderGraphMermaid(view(hashedDevProd)));
    golden("hashed.drawio", renderGraphDrawio(view(hashedDevProd)));
    golden("dropped.svg", `${renderGraphSvg(view(dropAddresses(devProd)))}\n`);
    golden("dropped.mmd", renderGraphMermaid(view(dropAddresses(devProd))));
    golden("dropped.drawio", renderGraphDrawio(view(dropAddresses(devProd))));
  });

  it("draws every one of those goldens, and the medium one, from a shuffled document in the same bytes", () => {
    const base = without(devProd, (n) => n.id === "db-prod");
    const cases: [string, GraphDocument, ProjectOptions, GraphDocument?][] = [
      ["dev-prod", devProd, { title: "dev and prod" }],
      ["dev-prod-delta", devProd, { delta: true }, base],
      ["hashed", hashedDevProd, {}],
      ["dropped", dropAddresses(devProd), {}],
      ["medium", medium, {}],
      ["large", large, {}],
    ];
    for (const [name, doc, options, baseDoc] of cases) {
      for (const seed of [11, 12]) {
        const v = view(shuffled(doc, seed), { ...options, ...(baseDoc && { base: shuffled(baseDoc, seed) }) });
        assert.equal(`${renderGraphSvg(v)}\n`, readFileSync(fixture(`golden/${name}.svg`), "utf8"), `${name}.svg, seed ${seed}`);
        assert.equal(renderGraphMermaid(v), readFileSync(fixture(`golden/${name}.mmd`), "utf8"), `${name}.mmd, seed ${seed}`);
        assert.equal(renderGraphDrawio(v), readFileSync(fixture(`golden/${name}.drawio`), "utf8"), `${name}.drawio, seed ${seed}`);
      }
    }
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
