// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type GlueRule, glueMatcher } from "./glue.ts";
import type { GraphDocument } from "./schema.ts";

/**
 * A graph document with its positional indexes replaced by keys that name a node
 * whatever order the document lists them in, so that the same estate gives the same
 * picture from any input order, and two documents can be compared node by node.
 *
 * A resource is its account, type and ID. A module call has no name in the document
 * (only its registry source and version), so it is its account, its source and a number
 * among the calls of that source in that account, counted in the order of what they
 * contain. A node the document lists twice gets a number after its key.
 */

/** Plain code-unit order: the same on every machine, unlike a locale's. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type NormalNode = {
  key: string;
  kind: "resource" | "module";
  type?: string;
  id?: string;
  account: string;
  region?: string;
  /** The environment of the node's root, when the graph names one. */
  environment?: string;
  source?: string;
  version?: string;
  /** The key of the module call the resource is in. */
  container?: string;
};

export type NormalGraph = {
  idsHashed: boolean;
  /** Everything drawn, resources and module calls, by key in key order. */
  nodes: Map<string, NormalNode>;
  /** The references between them, glue folded away, by key in key order. */
  edges: Map<string, { from: string; to: string }>;
  /** The glue resources, in key order: not drawn, but findings on them count for their container. */
  hidden: NormalNode[];
};

const resourceKey = (n: { account: string; type?: string | undefined; id?: string | undefined }) => `r|${n.account}|${n.type}|${n.id}`;

export function normalizeGraph(doc: GraphDocument, glue: Readonly<GlueRule> | false): NormalGraph {
  const isGlue = glueMatcher(glue);

  // Module calls first, numbered by what they contain, so a resource can name its call.
  const moduleIndexes = doc.nodes.flatMap((n, i) => (n.kind === "module" ? [i] : []));
  const childrenOf = new Map<number, string[]>();
  const resourceBase: (string | undefined)[] = doc.nodes.map((n) => (n.kind === "resource" ? resourceKey(n) : undefined));
  doc.nodes.forEach((n, i) => {
    const base = resourceBase[i];
    if (n.parent !== undefined && base !== undefined) childrenOf.set(n.parent, [...(childrenOf.get(n.parent) ?? []), base]);
  });
  const signature = (i: number) => (childrenOf.get(i) ?? []).sort(compareText).join("\n");
  const moduleGroups = new Map<string, number[]>();
  for (const i of moduleIndexes) {
    const n = doc.nodes[i];
    if (n === undefined) continue;
    const group = `m|${n.account}|${n.source}`;
    moduleGroups.set(group, [...(moduleGroups.get(group) ?? []), i]);
  }
  const keyOfIndex = new Map<number, string>();
  for (const [group, members] of moduleGroups) {
    members
      .sort(
        (a, b) =>
          compareText(signature(a), signature(b)) || compareText(doc.nodes[a]?.version ?? "", doc.nodes[b]?.version ?? ""),
      )
      .forEach((index, ordinal) => {
        keyOfIndex.set(index, `${group}|#${ordinal}`);
      });
  }

  // Then resources, numbered when the document lists one twice.
  const resourceIndexes = doc.nodes.flatMap((n, i) => (n.kind === "resource" ? [i] : []));
  const byBase = new Map<string, number[]>();
  for (const i of resourceIndexes) {
    const base = resourceBase[i] ?? "";
    byBase.set(base, [...(byBase.get(base) ?? []), i]);
  }
  for (const [base, members] of byBase) {
    const tie = (i: number) => {
      const n = doc.nodes[i];
      const container = n?.parent === undefined ? "" : (keyOfIndex.get(n.parent) ?? "");
      return `${n?.region ?? ""}|${container}`;
    };
    members
      .sort((a, b) => compareText(tie(a), tie(b)))
      .forEach((index, ordinal) => {
        keyOfIndex.set(index, ordinal === 0 ? base : `${base}|#${ordinal}`);
      });
  }

  const all = new Map<string, NormalNode>();
  doc.nodes.forEach((n, i) => {
    const key = keyOfIndex.get(i);
    if (key === undefined) return;
    const container = n.parent === undefined ? undefined : keyOfIndex.get(n.parent);
    all.set(key, {
      key,
      kind: n.kind,
      account: n.account,
      ...(n.type !== undefined && { type: n.type }),
      ...(n.id !== undefined && { id: n.id }),
      ...(n.region !== undefined && { region: n.region }),
      ...(n.environment !== undefined && { environment: n.environment }),
      ...(n.source !== undefined && { source: n.source }),
      ...(n.version !== undefined && { version: n.version }),
      ...(container !== undefined && { container }),
    });
  });

  const keys = [...all.keys()].sort(compareText);
  const hiddenKeys = new Set(keys.filter((key) => {
    const n = all.get(key);
    return n?.kind === "resource" && n.type !== undefined && isGlue(n.type);
  }));

  const successors = new Map<string, Set<string>>();
  for (const edge of doc.edges) {
    const from = keyOfIndex.get(edge.from);
    const to = keyOfIndex.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    successors.set(from, (successors.get(from) ?? new Set()).add(to));
  }

  // A line from a drawn node to a drawn node, directly or through glue alone.
  const edges = new Map<string, { from: string; to: string }>();
  for (const from of keys) {
    if (hiddenKeys.has(from)) continue;
    const seen = new Set<string>([from]);
    const walk = (at: string) => {
      for (const next of [...(successors.get(at) ?? [])].sort(compareText)) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (hiddenKeys.has(next)) walk(next);
        else edges.set(`${from} -> ${next}`, { from, to: next });
      }
    };
    walk(from);
  }

  const nodes = new Map<string, NormalNode>();
  const hidden: NormalNode[] = [];
  for (const key of keys) {
    const n = all.get(key);
    if (n === undefined) continue;
    if (hiddenKeys.has(key)) hidden.push(n);
    else nodes.set(key, n);
  }
  const sortedEdges = new Map([...edges].sort(([a], [b]) => compareText(a, b)));
  return { idsHashed: doc.redaction.ids_hashed, nodes, edges: sortedEdges, hidden };
}
