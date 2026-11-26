// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { EDGE_ACCESS_META, type EdgeAccess, type ModelNode } from "terragram-engine/model";

import type { ModelDiff } from "./model-diff.ts";

/**
 * The model diff as a Mermaid flowchart, which GitHub renders from a ```mermaid block.
 *
 * Added nodes and edges are green, removed ones red and dashed, changed ones amber.
 * Everything a model file carries is untrusted text here (the file is part of the pull
 * request), so labels are entity-encoded before they reach Mermaid, and nothing in a
 * label can end the code fence or open markup.
 */

type State = "added" | "removed" | "changed" | "same";

/** Mermaid's text limit is 50,000 characters and its edge limit 500; stay under both. */
const MAX_CHARS = 45_000;
const MAX_EDGES = 450;
const MAX_LABEL = 60;

export type Diagram = {
  /** The flowchart source, or null when there is nothing to draw (no changes) or it is too large. */
  mermaid: string | null;
  /** `full` is every node; `changes` is only what changed and the nodes beside it. */
  scope: "full" | "changes" | "omitted" | "none";
};

/** Encode a label for use inside a quoted Mermaid node (`#35;` style entities). */
export function mermaidText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const short = flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
  let out = "";
  for (const char of short) {
    if (/["#<>`&\\|[\]{}()]/.test(char)) out += `#${char.codePointAt(0)};`;
    else out += char;
  }
  return out;
}

type DrawNode = { node: ModelNode; state: State };
type DrawEdge = { source: string; target: string; state: State; access?: EdgeAccess };

function collect(diff: ModelDiff, changesOnly: boolean): { nodes: DrawNode[]; edges: DrawEdge[] } {
  const all = new Map<string, DrawNode>();
  const add = (node: ModelNode, state: State) => {
    all.set(node.id, { node, state });
  };
  for (const n of diff.nodes.unchanged) add(n, "same");
  for (const n of diff.nodes.added) add(n, "added");
  for (const n of diff.nodes.removed) add(n, "removed");
  for (const c of diff.nodes.changed) add(c.after, "changed");

  const edges: DrawEdge[] = [];
  const push = (source: string, target: string, state: State, access?: EdgeAccess) => {
    // An edge to a node the model does not contain cannot be drawn without inventing one.
    if (!all.has(source) || !all.has(target)) {
      return;
    }
    if (changesOnly && state === "same") return;
    edges.push(access ? { source, target, state, access } : { source, target, state });
  };
  for (const e of diff.edges.unchanged) push(e.source, e.target, "same", e.access);
  for (const e of diff.edges.added) push(e.source, e.target, "added", e.access);
  for (const e of diff.edges.removed) push(e.source, e.target, "removed", e.access);
  for (const c of diff.edges.changed) push(c.after.source, c.after.target, "changed", c.after.access);

  let nodes = [...all.values()].sort((a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  if (changesOnly) {
    const touched = new Set(edges.flatMap((e) => [e.source, e.target]));
    nodes = nodes.filter((n) => n.state !== "same" || touched.has(n.node.id));
  }
  return { nodes, edges };
}

function draw(nodes: DrawNode[], edges: DrawEdge[]): string {
  const ids = new Map(nodes.map((n, i) => [n.node.id, `n${i}`]));
  const lines = ["flowchart LR"];
  for (const { node } of nodes) {
    lines.push(`  ${ids.get(node.id)}["${mermaidText(node.label || node.id)}<br/>${mermaidText(node.kind)}"]`);
  }
  const styled: Record<Exclude<State, "same">, number[]> = { added: [], removed: [], changed: [] };
  edges.forEach((edge, index) => {
    const arrow = edge.state === "removed" ? "-.->" : "-->";
    // A typed edge says what it is on the line; the words come from a fixed list, never from the file.
    const typed = edge.access ? `|${EDGE_ACCESS_META[edge.access].label}|` : "";
    lines.push(`  ${ids.get(edge.source)} ${arrow}${typed} ${ids.get(edge.target)}`);
    if (edge.state !== "same") styled[edge.state].push(index);
  });
  lines.push(
    "  classDef added fill:#d1fae5,stroke:#047857,stroke-width:2px,color:#064e3b",
    "  classDef removed fill:#fee2e2,stroke:#b91c1c,stroke-width:2px,stroke-dasharray:5 5,color:#7f1d1d",
    "  classDef changed fill:#fef3c7,stroke:#b45309,stroke-width:2px,color:#78350f",
  );
  for (const state of ["added", "removed", "changed"] as const) {
    const members = nodes.filter((n) => n.state === state).map((n) => ids.get(n.node.id));
    if (members.length > 0) lines.push(`  class ${members.join(",")} ${state}`);
  }
  const stroke = { added: "#047857", removed: "#b91c1c", changed: "#b45309" } as const;
  for (const state of ["added", "removed", "changed"] as const) {
    if (styled[state].length > 0) lines.push(`  linkStyle ${styled[state].join(",")} stroke:${stroke[state]},stroke-width:2px`);
  }
  return lines.join("\n");
}

/** Draw the diff, falling back to the changed part alone when the whole is too big for Mermaid. */
export function renderDiagram(diff: ModelDiff): Diagram {
  const changed =
    diff.nodes.added.length + diff.nodes.removed.length + diff.nodes.changed.length +
    diff.edges.added.length + diff.edges.removed.length + diff.edges.changed.length;
  if (changed === 0) return { mermaid: null, scope: "none" };

  const full = collect(diff, false);
  const whole = draw(full.nodes, full.edges);
  if (whole.length <= MAX_CHARS && full.edges.length <= MAX_EDGES) return { mermaid: whole, scope: "full" };

  const part = collect(diff, true);
  const partial = draw(part.nodes, part.edges);
  if (partial.length <= MAX_CHARS && part.edges.length <= MAX_EDGES) return { mermaid: partial, scope: "changes" };
  return { mermaid: null, scope: "omitted" };
}
