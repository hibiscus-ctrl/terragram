// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { EdgeStatus, GraphStatus, GraphView, ViewGroup, ViewNode } from "./project.ts";

/**
 * A {@link GraphView} as a Mermaid flowchart, for places that draw Mermaid themselves,
 * such as a pull request comment: scopes and module calls are subgraphs, a reference is
 * an arrow from the resource that refers to the one it refers to. Statuses and findings
 * are in the text of the node (`+ `, `- `, `~ `, and a count), and in a class for colour.
 */

/** Mermaid text in quotes: entity codes for what would end the string or be read as markup. */
function text(value: string): string {
  const entities: Record<string, string> = { "#": "#35;", '"': "#quot;", "<": "#lt;", ">": "#gt;", "&": "#amp;", "|": "#124;", "`": "#96;" };
  return [...value].filter((ch) => ch >= " ").map((ch) => entities[ch] ?? ch).join("");
}

const MARK: Partial<Record<GraphStatus, string>> = { added: "+ ", removed: "- ", changed: "~ " };

const CLASS_STYLE: Record<string, string> = {
  added: "fill:#f0fdf4,stroke:#15803d,color:#14532d",
  removed: "fill:#fef2f2,stroke:#b91c1c,color:#7f1d1d,stroke-dasharray:4 3",
  changed: "fill:#fffbeb,stroke:#b45309,color:#78350f",
  context: "fill:#ffffff,stroke:#a8a090,color:#665e4f,opacity:0.6",
  critical: "stroke:#7f1d1d,stroke-width:3px",
  high: "stroke:#b91c1c,stroke-width:3px",
  medium: "stroke:#b45309,stroke-width:3px",
  low: "stroke:#a16207,stroke-width:3px",
  info: "stroke:#475569,stroke-width:3px",
};

const LINK: Record<EdgeStatus, { arrow: string; style?: string }> = {
  unchanged: { arrow: "-->" },
  added: { arrow: "==>", style: "stroke:#15803d,stroke-width:2px" },
  removed: { arrow: "-.->", style: "stroke:#b91c1c,stroke-width:2px" },
};

function nodeLine(node: ViewNode, indent: string): string {
  const mark = MARK[node.status] ?? "";
  const findings = node.findings ? ` [${node.findings.count} ${node.findings.worst}]` : "";
  return `${indent}${node.id}["${text(`${mark}${node.type}`)}<br/>${text(node.label)}${text(findings)}"]`;
}

function groupTitle(group: ViewGroup): string {
  const status = group.status === "unchanged" || group.status === "context" ? "" : ` [${group.status}]`;
  const findings = group.findings ? ` [${group.findings.count} ${group.findings.worst}]` : "";
  return `${group.label}${group.detail ? ` ${group.detail}` : ""}${status}${findings}`;
}

export function renderGraphMermaid(view: GraphView): string {
  const lines: string[] = [];
  if (view.title) lines.push(`---`, `title: "${text(view.title)}"`, `---`);
  lines.push("flowchart TB");
  if (view.nodes.length === 0) lines.push(`  empty["${view.mode === "delta" ? "No changes." : "No resources to draw."}"]`);

  const emit = (group: ViewGroup, depth: number) => {
    const pad = "  ".repeat(depth);
    lines.push(`${pad}subgraph ${group.id}["${text(groupTitle(group))}"]`);
    for (const child of view.groups) if (child.parent === group.id) emit(child, depth + 1);
    for (const node of view.nodes) if (node.group === group.id) lines.push(nodeLine(node, `${pad}  `));
    lines.push(`${pad}end`);
  };
  for (const group of view.groups) if (group.parent === null) emit(group, 1);

  const styled = new Map<string, string[]>();
  const classify = (name: string, id: string) => styled.set(name, [...(styled.get(name) ?? []), id]);
  for (const node of view.nodes) {
    if (node.status !== "unchanged") classify(node.status, node.id);
    if (node.findings) classify(node.findings.worst, node.id);
  }

  const linkStyles: string[] = [];
  view.edges.forEach((edge, i) => {
    const link = LINK[edge.status];
    lines.push(`  ${edge.from} ${link.arrow} ${edge.to}`);
    if (link.style) linkStyles.push(`  linkStyle ${i} ${link.style}`);
  });
  lines.push(...linkStyles);

  for (const name of Object.keys(CLASS_STYLE)) {
    const ids = styled.get(name);
    if (ids === undefined) continue;
    lines.push(`  classDef ${name} ${CLASS_STYLE[name]}`, `  class ${ids.join(",")} ${name}`);
  }
  return `${lines.join("\n")}\n`;
}
