// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type FindingTally, type GraphFinding, SEVERITIES, type Severity, tally } from "./findings.ts";
import { diffNormal } from "./diff.ts";
import { DEFAULT_GLUE, type GlueRule } from "./glue.ts";
import { compareText, type NormalGraph, type NormalNode, normalizeGraph } from "./normalize.ts";
import type { GraphDocument } from "./schema.ts";

/**
 * The drawing of an estate before any drawing: what is in the picture, how it nests
 * and what is connected to what, with every id and every order fixed by the content of
 * the document, never by the order it was written in. The SVG and Mermaid renderers
 * both read this, and `terragram graph --format json` prints it.
 *
 * The nesting is scope (an account, subscription or project) then module call, then the
 * resources. A resource of a module call is inside it; a module call that other
 * resources refer to, or that changed, has a card of its own inside its box, because a
 * line has to end somewhere.
 */

export type GraphStatus = "unchanged" | "added" | "removed" | "changed" | "context";
export type EdgeStatus = "unchanged" | "added" | "removed";
export type GraphCategory = "network" | "compute" | "storage" | "identity" | "data" | "other";

export type ViewGroup = {
  id: string;
  kind: "scope" | "module";
  label: string;
  detail?: string;
  parent: string | null;
  status: GraphStatus;
  findings: FindingTally | null;
};

export type ViewNode = {
  id: string;
  group: string;
  /** The resource type, or `module call` for a module's card. */
  type: string;
  label: string;
  category: GraphCategory;
  region?: string;
  status: GraphStatus;
  findings: FindingTally | null;
};

export type ViewEdge = { from: string; to: string; status: EdgeStatus };

export type GraphView = {
  schema: "terragram.graph-view/v1";
  cloud: GraphDocument["cloud"];
  title?: string;
  mode: "full" | "delta";
  /** A base graph was given, so statuses say what changed. */
  compared: boolean;
  groups: ViewGroup[];
  nodes: ViewNode[];
  edges: ViewEdge[];
  hidden: { count: number; types: { type: string; count: number }[] };
  /** Counts of what changed between base and head, with glue left out. */
  changes?: { nodesAdded: number; nodesRemoved: number; nodesChanged: number; edgesAdded: number; edgesRemoved: number };
  /** How many findings were given, how many found nothing to attach to, and how many of each severity were placed. */
  findings?: { total: number; unplaced: number; bySeverity: Partial<Record<Severity, number>> };
};

export type ProjectOptions = {
  title?: string;
  /** Which resources to leave out as glue; `false` leaves out none. Default: {@link DEFAULT_GLUE}. */
  glue?: Readonly<GlueRule> | false;
  /** The estate before: compare it with the document, and mark what was added, removed or changed. */
  base?: GraphDocument;
  /** With `base`: draw only what changed and the nodes one reference away from it. */
  delta?: boolean;
  findings?: readonly GraphFinding[];
  /** Turn a Terraform address into the type and ID graph/v1 names a resource by, when the caller can. */
  resolveAddress?: (address: string) => { type: string; id: string; account?: string } | undefined;
};

const PROVIDER_NAME = { aws: "AWS account", azure: "Azure subscription", google: "Google Cloud project" } as const;

const CATEGORY_TOKENS: readonly (readonly [GraphCategory, ReadonlySet<string>])[] = [
  ["identity", new Set(["iam", "role", "policy", "identity", "principal", "account", "kms", "key", "secret", "vault"])],
  ["data", new Set(["db", "rds", "dynamodb", "sql", "cosmosdb", "redis", "cache", "elasticache", "bigtable", "spanner", "mysql", "postgresql", "database", "redshift"])],
  ["storage", new Set(["s3", "bucket", "storage", "disk", "volume", "ebs", "efs", "blob", "file", "backup", "snapshot"])],
  ["network", new Set(["vpc", "subnet", "subnetwork", "route", "gateway", "network", "nat", "vnet", "firewall", "dns", "lb", "elb", "alb", "nlb", "security", "nsg", "eip", "endpoint", "peering", "vpn", "cloudfront", "cdn", "nic", "ip"])],
  ["compute", new Set(["instance", "lambda", "function", "ecs", "eks", "container", "cluster", "kubernetes", "vm", "machine", "autoscaling", "launch", "app", "batch", "compute", "service"])],
];

/** A coarse kind for colouring: read off the words of a Terraform resource type. */
function categoryOf(type: string): GraphCategory {
  const tokens = type.split("_");
  for (const [category, words] of CATEGORY_TOKENS) {
    if (tokens.some((token) => words.has(token))) return category;
  }
  return "other";
}

/** A resource ID short enough for a card: a hashed ID by its first characters, a path by its last part. */
function shortId(id: string, hashed: boolean): string {
  const text = hashed ? id.slice(0, 8) : (id.split("/").filter(Boolean).pop() ?? id);
  const clean = [...text].map((ch) => (ch < " " ? "?" : ch)).join("");
  return clean.length > 24 ? `${clean.slice(0, 23)}…` : clean;
}

function shortSource(source: string): string {
  const clean = [...source].map((ch) => (ch < " " ? "?" : ch)).join("");
  return clean.length > 40 ? `…${clean.slice(-39)}` : clean;
}

type Entry = { node: NormalNode; status: GraphStatus };

type Resolver = NonNullable<ProjectOptions["resolveAddress"]>;

/** Which findings sit on which node or scope, and how many found nothing to sit on. */
function placeFindings(head: NormalGraph, findings: readonly GraphFinding[], resolve: Resolver | undefined) {
  const onNode = new Map<string, Severity[]>();
  const onAccount = new Map<string, Severity[]>();
  const onModule = new Map<string, Severity[]>();
  const push = (map: Map<string, Severity[]>, key: string, severity: Severity) => map.set(key, [...(map.get(key) ?? []), severity]);

  const resources = [...head.nodes.values(), ...head.hidden].filter((n) => n.kind === "resource");
  const byIdentity = new Map<string, NormalNode[]>();
  for (const n of resources) byIdentity.set(`${n.type}|${n.id}`, [...(byIdentity.get(`${n.type}|${n.id}`) ?? []), n]);
  const placed: Severity[] = [];

  for (const finding of findings) {
    const resolved = finding.type === undefined && finding.address !== undefined ? resolve?.(finding.address) : undefined;
    const type = finding.type ?? resolved?.type;
    const id = finding.id ?? resolved?.id;
    const account = finding.account ?? resolved?.account;
    if (type !== undefined && id !== undefined) {
      const matches = (byIdentity.get(`${type}|${id}`) ?? []).filter((n) => account === undefined || n.account === account);
      if (matches.length === 0) continue;
      for (const n of matches) {
        if (head.nodes.has(n.key)) push(onNode, n.key, finding.severity);
        else if (n.container !== undefined) push(onModule, n.container, finding.severity);
        else push(onAccount, n.account, finding.severity);
      }
      placed.push(finding.severity);
    } else if (account !== undefined && resources.some((n) => n.account === account)) {
      push(onAccount, account, finding.severity);
      placed.push(finding.severity);
    }
  }
  return { onNode, onAccount, onModule, placed };
}

export function projectGraph(doc: GraphDocument, options: ProjectOptions = {}): GraphView {
  if (options.delta && options.base === undefined) throw new Error("a delta view needs a base graph to compare with");
  const glue = options.glue === undefined ? DEFAULT_GLUE : options.glue;
  const head = normalizeGraph(doc, glue);
  const base = options.base ? normalizeGraph(options.base, glue) : undefined;
  const diff = base ? diffNormal(base, head) : undefined;

  // Everything in either graph, with what became of it.
  const entries = new Map<string, Entry>();
  const added = new Set(diff?.nodes.added.map((n) => n.key));
  const changed = new Set(diff?.nodes.changed.map((c) => c.after.key));
  for (const [key, node] of head.nodes) {
    entries.set(key, { node, status: added.has(key) ? "added" : changed.has(key) ? "changed" : "unchanged" });
  }
  for (const node of diff?.nodes.removed ?? []) entries.set(node.key, { node, status: "removed" });

  const edges = new Map<string, { from: string; to: string; status: EdgeStatus }>();
  for (const [key, edge] of head.edges) edges.set(key, { ...edge, status: base && !base.edges.has(key) ? "added" : "unchanged" });
  for (const [key, edge] of base?.edges ?? []) if (!head.edges.has(key)) edges.set(key, { ...edge, status: "removed" });

  // Delta: the changes, and the nodes one reference from them.
  const shown = new Map(entries);
  let shownEdges = [...edges.values()];
  if (options.delta) {
    const core = new Set([...entries].filter(([, e]) => e.status !== "unchanged").map(([key]) => key));
    const context = new Set<string>();
    for (const edge of edges.values()) {
      const touchesCore = core.has(edge.from) || core.has(edge.to);
      if (!touchesCore && edge.status === "unchanged") continue;
      for (const end of [edge.from, edge.to]) if (!core.has(end)) context.add(end);
    }
    shownEdges = shownEdges.filter((e) => e.status !== "unchanged" || core.has(e.from) || core.has(e.to));
    for (const key of entries.keys()) if (!core.has(key) && !context.has(key)) shown.delete(key);
    for (const key of context) {
      const entry = shown.get(key);
      if (entry) shown.set(key, { ...entry, status: "context" });
    }
  }

  const touched = new Set(shownEdges.flatMap((e) => [e.from, e.to]));
  const accountOf = (key: string) => entries.get(key)?.node.account ?? "";

  // A module call is a box; it gets a card only if a line ends at it or it changed.
  const moduleKeys = [...shown.keys()].filter((key) => shown.get(key)?.node.kind === "module").sort(compareText);
  const cardKeys = new Set(moduleKeys.filter((key) => touched.has(key) || shown.get(key)?.status !== "unchanged"));
  const resourceKeys = [...shown.keys()].filter((key) => shown.get(key)?.node.kind === "resource").sort(compareText);
  const containerOf = (key: string) => {
    const container = shown.get(key)?.node.container;
    return container !== undefined && entries.has(container) ? container : undefined;
  };
  const usedModules = new Set([...cardKeys, ...resourceKeys.map(containerOf).filter((c): c is string => c !== undefined)]);
  const boxModules = [...entries.keys()].filter((key) => usedModules.has(key) && entries.get(key)?.node.kind === "module").sort(compareText);

  const accounts = [...new Set([...resourceKeys, ...boxModules].map(accountOf))].sort(compareText);
  const placement = placeFindings(head, options.findings ?? [], options.resolveAddress);

  const groups: ViewGroup[] = accounts.map((account, i) => ({
    id: `g${i}`,
    kind: "scope",
    label: `${PROVIDER_NAME[doc.cloud]} ${account}`,
    parent: null,
    status: "unchanged",
    findings: tally(placement.onAccount.get(account) ?? []),
  }));
  const scopeId = new Map(accounts.map((account, i) => [account, `g${i}`]));
  const moduleId = new Map<string, string>();
  boxModules.forEach((key, i) => {
    const entry = shown.get(key) ?? entries.get(key);
    if (entry === undefined) return;
    const id = `g${accounts.length + i}`;
    moduleId.set(key, id);
    groups.push({
      id,
      kind: "module",
      label: `module ${shortSource(entry.node.source ?? "")}`,
      ...(entry.node.version !== undefined && { detail: entry.node.version }),
      parent: scopeId.get(entry.node.account) ?? null,
      status: entry.status === "context" ? "unchanged" : entry.status,
      findings: tally(placement.onModule.get(key) ?? []),
    });
  });

  const viewKeys = [...new Set([...resourceKeys, ...cardKeys])].sort(compareText);
  const nodeId = new Map(viewKeys.map((key, i) => [key, `n${i}`]));
  const nodes: ViewNode[] = [];
  for (const key of viewKeys) {
    const entry = shown.get(key);
    const id = nodeId.get(key);
    if (entry === undefined || id === undefined) continue;
    const n = entry.node;
    const container = containerOf(key);
    const isCard = n.kind === "module";
    const group = (isCard ? moduleId.get(key) : container === undefined ? undefined : moduleId.get(container)) ?? scopeId.get(n.account) ?? "";
    nodes.push({
      id,
      group,
      type: isCard ? "module call" : (n.type ?? ""),
      label: isCard ? shortSource(n.source ?? "") : shortId(n.id ?? "", head.idsHashed),
      category: isCard ? "other" : categoryOf(n.type ?? ""),
      ...(n.region !== undefined && !isCard && { region: n.region }),
      status: entry.status,
      findings: tally(placement.onNode.get(key) ?? []),
    });
  }

  const viewEdges: ViewEdge[] = shownEdges
    .flatMap((e) => {
      const from = nodeId.get(e.from);
      const to = nodeId.get(e.to);
      return from !== undefined && to !== undefined ? [{ from, to, status: e.status, sort: `${e.from} ${e.to}` }] : [];
    })
    .sort((a, b) => compareText(a.sort, b.sort))
    .map(({ from, to, status }) => ({ from, to, status }));

  const hiddenCounts = new Map<string, number>();
  for (const n of head.hidden) hiddenCounts.set(n.type ?? "", (hiddenCounts.get(n.type ?? "") ?? 0) + 1);

  const given = options.findings ?? [];
  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const severity of SEVERITIES) {
    const n = placement.placed.filter((s) => s === severity).length;
    if (n > 0) bySeverity[severity] = n;
  }

  return {
    schema: "terragram.graph-view/v1",
    cloud: doc.cloud,
    ...(options.title !== undefined && { title: options.title }),
    mode: options.delta ? "delta" : "full",
    compared: base !== undefined,
    groups,
    nodes,
    edges: viewEdges,
    hidden: {
      count: head.hidden.length,
      types: [...hiddenCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || compareText(a.type, b.type)),
    },
    ...(diff && {
      changes: {
        nodesAdded: diff.nodes.added.length,
        nodesRemoved: diff.nodes.removed.length,
        nodesChanged: diff.nodes.changed.length,
        edgesAdded: diff.edges.added.length,
        edgesRemoved: diff.edges.removed.length,
      },
    }),
    ...(given.length > 0 && { findings: { total: given.length, unplaced: given.length - placement.placed.length, bySeverity } }),
  };
}
