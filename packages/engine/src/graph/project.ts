// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type GraphFinding, SEVERITIES, type Severity, tally } from "./findings.ts";
import { diffNormal } from "./diff.ts";
import { DEFAULT_GLUE, type GlueRule } from "./glue.ts";
import { atLevel, cutView, focusView } from "./levels.ts";
import { compareText, type NormalGraph, type NormalNode, normalizeGraph } from "./normalize.ts";
import type { GraphDocument } from "./schema.ts";
import { serviceOf } from "./services.ts";
import type { EdgeStatus, FocusOptions, GraphLevel, GraphStatus, GraphView, ViewEdge, ViewGroup, ViewNode } from "./view.ts";

/**
 * The drawing of an estate before any drawing: what is in the picture, how it nests
 * and what is connected to what, with every id and every order fixed by the content of
 * the document, never by the order it was written in. The SVG and Mermaid renderers
 * both read this, and `terragram graph --format json` prints it.
 *
 * The nesting is scope (an account, subscription or project), then environment (when the
 * graph names the environment of its roots), then module call, then the resources. A
 * resource of a module call is inside it; a module call that other resources refer to, or
 * that changed, has a card of its own inside its box, because a line has to end somewhere.
 * A node with no environment sits directly in its scope: that level is skipped for it, not
 * given a box of its own, so a graph that names no environment has no environment boxes.
 *
 * Everything is placed by one order: scope, then environment name, then module path (the
 * module call's address), then the resource's Terraform address, then its root, then its key
 * (account, type and ID). The address and the root count only when the graph keeps them as they
 * are (`redaction.addresses` `plain`); where it hashed or dropped them, or never had them, the
 * key alone decides, as it always did. The ids `g0`, `n0` and the order of the groups, nodes and
 * edges follow it, so the same estate is the same picture whatever order the document lists it in.
 */

/**
 * The most cards a picture holds. A larger estate is cut to its first ones in the order of the picture
 * (scope, environment, module path, address, key) and the view says so in `cut`: the layout is the costly part
 * and no reader can use a canvas of more.
 */
export const MAX_GRAPH_NODES = 1000;

export type ProjectOptions = {
  title?: string;
  /** Cards to draw at most, from the start of the picture's order. Default: {@link MAX_GRAPH_NODES}. */
  maxNodes?: number;
  /** Which resources to leave out as glue; `false` leaves out none. Default: {@link DEFAULT_GLUE}. */
  glue?: Readonly<GlueRule> | false;
  /** The estate before: compare it with the document, and mark what was added, removed or changed. */
  base?: GraphDocument;
  /** With `base`: draw only what changed and the nodes one reference away from it. */
  delta?: boolean;
  /**
   * How much to draw: `detailed` (the default) a card per resource, `services` the resources of one service in a group as one card
   * (`Lambda x12`), `overview` each group as one summary card with its resources counted by category. The references between cards
   * are added up. Ids of the cards that stand for several resources are `a0`, `a1`, and `aggregate` lists the ids they stand for.
   */
  level?: GraphLevel;
  /** Draw only this node, the nodes within `hops` references of it (either direction) and the boxes around them. Applied after `level` and `delta`. */
  focus?: FocusOptions;
  findings?: readonly GraphFinding[];
  /** Turn a Terraform address into the type and ID graph/v1 names a resource by, for an address the graph itself does not keep or does not tell apart. */
  resolveAddress?: (address: string) => { type: string; id: string; account?: string } | undefined;
};

const PROVIDER_NAME = { aws: "AWS account", azure: "Azure subscription", google: "Google Cloud project" } as const;

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

/** The key of an environment inside a scope. */
const environmentKey = (account: string, environment: string) => `${account}\u0000${environment}`;

/** Which findings sit on which node or scope, and how many found nothing to sit on. */
function placeFindings(head: NormalGraph, findings: readonly GraphFinding[], resolve: Resolver | undefined) {
  const onNode = new Map<string, Severity[]>();
  const onAccount = new Map<string, Severity[]>();
  const onEnvironment = new Map<string, Severity[]>();
  const onModule = new Map<string, Severity[]>();
  const push = (map: Map<string, Severity[]>, key: string, severity: Severity) => map.set(key, [...(map.get(key) ?? []), severity]);

  const all = [...head.nodes.values(), ...head.hidden];
  const resources = all.filter((n) => n.kind === "resource");
  const byIdentity = new Map<string, NormalNode[]>();
  for (const n of resources) byIdentity.set(`${n.type}|${n.id}`, [...(byIdentity.get(`${n.type}|${n.id}`) ?? []), n]);
  // What the graph itself keeps of addresses: a resource's, or a module call's.
  const byAddress = new Map<string, NormalNode[]>();
  for (const n of all) {
    const address = n.kind === "resource" ? n.address : n.moduleAddress;
    if (address !== undefined) byAddress.set(address, [...(byAddress.get(address) ?? []), n]);
  }
  const placed: Severity[] = [];

  /** Where a finding on `n` is shown: a module call's box, a resource's card, or for a hidden glue resource what it sits in (its module call, environment or scope). */
  const place = (n: NormalNode, severity: Severity) => {
    if (n.kind === "module") push(onModule, n.key, severity);
    else if (head.nodes.has(n.key)) push(onNode, n.key, severity);
    else if (n.container !== undefined) push(onModule, n.container, severity);
    else if (n.environment !== undefined) push(onEnvironment, environmentKey(n.account, n.environment), severity);
    else push(onAccount, n.account, severity);
  };

  for (const finding of findings) {
    const where = (n: NormalNode) =>
      (finding.account === undefined || n.account === finding.account) &&
      (finding.environment === undefined || n.environment === finding.environment) &&
      (finding.root === undefined || n.root === finding.root);

    if (finding.type === undefined && finding.address !== undefined) {
      // The graph's own address: one node, since the same address recurs in every root.
      const own = (byAddress.get(finding.address) ?? []).filter(where);
      if (own.length === 1 && own[0] !== undefined) {
        place(own[0], finding.severity);
        placed.push(finding.severity);
        continue;
      }
    }
    const resolved = finding.type === undefined && finding.address !== undefined ? resolve?.(finding.address) : undefined;
    const type = finding.type ?? resolved?.type;
    const id = finding.id ?? resolved?.id;
    const account = finding.account ?? resolved?.account;
    if (type !== undefined && id !== undefined) {
      const matches = (byIdentity.get(`${type}|${id}`) ?? []).filter(
        (n) =>
          (account === undefined || n.account === account) &&
          (finding.environment === undefined || n.environment === finding.environment) &&
          (finding.root === undefined || n.root === finding.root),
      );
      if (matches.length === 0) continue;
      for (const n of matches) place(n, finding.severity);
      placed.push(finding.severity);
    } else if (finding.address === undefined && account !== undefined && resources.some((n) => n.account === account)) {
      // A finding that names no resource is the account's. One that names an address which
      // did not narrow to a node (several roots share it, or it is hashed or dropped) is about
      // a resource we cannot find, and showing it as an account-wide finding would say more
      // than the finding does, so it stays unplaced.
      push(onAccount, account, finding.severity);
      placed.push(finding.severity);
    }
  }
  return { onNode, onAccount, onEnvironment, onModule, placed };
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
  const environmentOf = (key: string) => entries.get(key)?.node.environment;
  /** The address of the module call a node is in, or of the call itself. */
  const modulePathOf = (key: string) => {
    const node = entries.get(key)?.node;
    const call = node?.kind === "module" ? node : node?.container === undefined ? undefined : entries.get(node.container)?.node;
    return call?.placeAddress ?? "";
  };
  /** The one order of the picture: scope, environment, module path, address, root, key. */
  const byPlace = (a: string, b: string) =>
    compareText(accountOf(a), accountOf(b)) ||
    compareText(environmentOf(a) ?? "", environmentOf(b) ?? "") ||
    compareText(modulePathOf(a), modulePathOf(b)) ||
    compareText(entries.get(a)?.node.placeAddress ?? "", entries.get(b)?.node.placeAddress ?? "") ||
    compareText(entries.get(a)?.node.placeRoot ?? "", entries.get(b)?.node.placeRoot ?? "") ||
    compareText(a, b);

  // A module call is a box; it gets a card only if a line ends at it or it changed.
  const moduleKeys = [...shown.keys()].filter((key) => shown.get(key)?.node.kind === "module").sort(compareText);
  const cardKeys = new Set(moduleKeys.filter((key) => touched.has(key) || shown.get(key)?.status !== "unchanged"));
  const resourceKeys = [...shown.keys()].filter((key) => shown.get(key)?.node.kind === "resource").sort(compareText);
  const containerOf = (key: string) => {
    const container = shown.get(key)?.node.container;
    return container !== undefined && entries.has(container) ? container : undefined;
  };
  const usedModules = new Set([...cardKeys, ...resourceKeys.map(containerOf).filter((c): c is string => c !== undefined)]);
  const boxModules = [...entries.keys()].filter((key) => usedModules.has(key) && entries.get(key)?.node.kind === "module").sort(byPlace);

  const accounts = [...new Set([...resourceKeys, ...boxModules].map(accountOf))].sort(compareText);
  // An environment box sits in a scope, around the module boxes and the resources of that root
  // that are not in a module box. Where a graph names no environment there are none.
  const inEnvironment = [...boxModules, ...resourceKeys.filter((key) => containerOf(key) === undefined)];
  const environments = [...new Set(inEnvironment.flatMap((key) => {
    const environment = environmentOf(key);
    return environment === undefined ? [] : [environmentKey(accountOf(key), environment)];
  }))].sort(compareText);
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
  const environmentId = new Map<string, string>();
  for (const key of environments) {
    const [account = "", environment = ""] = key.split("\u0000");
    const id = `g${accounts.length + environmentId.size}`;
    environmentId.set(key, id);
    groups.push({
      id,
      kind: "environment",
      label: `environment ${environment}`,
      parent: scopeId.get(account) ?? null,
      status: "unchanged",
      findings: tally(placement.onEnvironment.get(key) ?? []),
    });
  }
  /** The box a node that is in no module box sits in: its environment's, else its scope's. */
  const boxOf = (account: string, environment: string | undefined) =>
    (environment === undefined ? undefined : environmentId.get(environmentKey(account, environment))) ?? scopeId.get(account);
  const moduleId = new Map<string, string>();
  boxModules.forEach((key, i) => {
    const entry = shown.get(key) ?? entries.get(key);
    if (entry === undefined) return;
    const id = `g${accounts.length + environments.length + i}`;
    moduleId.set(key, id);
    groups.push({
      id,
      kind: "module",
      label: `module ${shortSource(entry.node.source ?? "")}`,
      ...(entry.node.version !== undefined && { detail: entry.node.version }),
      parent: boxOf(entry.node.account, entry.node.environment) ?? null,
      status: entry.status === "context" ? "unchanged" : entry.status,
      findings: tally(placement.onModule.get(key) ?? []),
    });
  });

  const viewKeys = [...new Set([...resourceKeys, ...cardKeys])].sort(byPlace);
  const nodeIndex = new Map(viewKeys.map((key, i) => [key, i]));
  const nodeId = new Map(viewKeys.map((key, i) => [key, `n${i}`]));
  const nodes: ViewNode[] = [];
  for (const key of viewKeys) {
    const entry = shown.get(key);
    const id = nodeId.get(key);
    if (entry === undefined || id === undefined) continue;
    const n = entry.node;
    const container = containerOf(key);
    const isCard = n.kind === "module";
    const group = (isCard ? moduleId.get(key) : container === undefined ? undefined : moduleId.get(container)) ?? boxOf(n.account, n.environment) ?? "";
    const service = isCard ? undefined : serviceOf(n.type ?? "");
    nodes.push({
      id,
      group,
      type: isCard ? "module call" : (n.type ?? ""),
      label: isCard ? shortSource(n.source ?? "") : shortId(n.id ?? "", head.idsHashed),
      service: service?.id ?? "terraform.module",
      category: service?.category ?? "other",
      ...(n.region !== undefined && !isCard && { region: n.region }),
      ...(n.environment !== undefined && { environment: n.environment }),
      status: entry.status,
      findings: tally(placement.onNode.get(key) ?? []),
    });
  }

  const viewEdges: ViewEdge[] = shownEdges
    .flatMap((e) => {
      const from = nodeId.get(e.from);
      const to = nodeId.get(e.to);
      return from !== undefined && to !== undefined ? [{ from, to, status: e.status, at: [nodeIndex.get(e.from) ?? 0, nodeIndex.get(e.to) ?? 0] as const }] : [];
    })
    .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1])
    .map(({ from, to, status }) => ({ from, to, status, count: 1 }));

  const hiddenCounts = new Map<string, number>();
  for (const n of head.hidden) hiddenCounts.set(n.type ?? "", (hiddenCounts.get(n.type ?? "") ?? 0) + 1);

  const given = options.findings ?? [];
  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const severity of SEVERITIES) {
    const n = placement.placed.filter((s) => s === severity).length;
    if (n > 0) bySeverity[severity] = n;
  }

  const view: GraphView = {
    schema: "diagram.graph-view/v2",
    cloud: doc.cloud,
    ...(options.title !== undefined && { title: options.title }),
    mode: options.delta ? "delta" : "full",
    level: "detailed",
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
  // The level and the focus change which cards there are, so the cut is of what is left: an estate of ten thousand
  // resources is whole at the Overview level.
  const leveled = atLevel(view, options.level ?? "detailed");
  return cutView(options.focus === undefined ? leveled : focusView(leveled, options.focus), options.maxNodes ?? MAX_GRAPH_NODES);
}
