// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { fieldsForKind, kindDefinition } from "./kinds.ts";
import {
  CATEGORY_META,
  type Cloud,
  EDGE_ACCESS_META,
  type EdgeAccess,
  type InfraModel,
  type ModelNode,
  type NodeCategory,
  resourceNodes,
} from "./model.ts";

/**
 * Model → plain English. The other half of the review gate.
 *
 * The stated audience includes reviewers who do not read HCL, so an approval screen
 * that only shows a diagram and a plan is asking them to sign for something they
 * cannot read. This produces the description they actually approve, and the receipt
 * records it, so the evidence says what the approver was shown.
 *
 * The deterministic walk below is always available — no key, no network, no gateway.
 * Managed inference only ever rewrites this text into better prose; it is never the
 * source of the facts.
 */

const CLOUD_LABEL: Record<Cloud, string> = { azure: "Azure", aws: "AWS" };

const CATEGORY_ORDER: NodeCategory[] = [
  "compute",
  "network",
  "storage",
  "identity",
  "observability",
  "edge",
];

function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A node's chosen attributes as a readable clause, e.g. "Compute tier: Dev / Test". */
function attributeClause(node: ModelNode): string {
  const fields = fieldsForKind(node.kind);
  const chosen = fields
    .map((field) => {
      const value = node.attributes?.[field.key];
      return value ? `${field.key.toLowerCase()} ${value}` : null;
    })
    .filter((v): v is string => v !== null);
  return chosen.length > 0 ? ` (${humanList(chosen)})` : "";
}

function nodeLabel(node: ModelNode): string {
  return node.label || kindDefinition(node.kind)?.label || node.kind;
}

function connection(access: EdgeAccess | undefined): string {
  return access ? EDGE_ACCESS_META[access].phrase : "connects to";
}

const whenConditional = (edge: { access?: EdgeAccess | undefined; conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined }) =>
  edge.access && edge.conditional
    ? edge.unconditional
      ? ` (conditional; ${EDGE_ACCESS_META[edge.unconditional].label} without the condition)`
      : " (conditional)"
    : "";

/**
 * Describe the model in plain English. Pure and deterministic, so it is unit-testable
 * and can be regenerated identically when verifying a receipt.
 */
export function explainModel(model: InfraModel, cloud: Cloud, regionLabel: string): string {
  const resources = resourceNodes(model);
  if (resources.length === 0) {
    return "This workspace has no infrastructure yet. Describe what you need, or paste existing Terraform, and the description will appear here.";
  }

  const paragraphs: string[] = [];

  paragraphs.push(
    `This design targets ${CLOUD_LABEL[cloud]} in ${regionLabel}. It has ${resources.length} ${
      resources.length === 1 ? "component" : "components"
    }${model.topology === "manual" ? ", with connections you set by hand" : ""}.`,
  );

  /* ---------------------------------------------------------- the request path -- */

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const internet = model.nodes.find((n) => n.kind === "internet");
  if (internet) {
    const path: string[] = [];
    let current = internet.id;
    const visited = new Set<string>([current]);
    while (true) {
      const next = model.edges.find((e) => e.source === current && !visited.has(e.target));
      if (!next) break;
      const node = byId.get(next.target);
      if (!node) break;
      path.push(nodeLabel(node));
      visited.add(node.id);
      current = node.id;
      if (path.length > 6) break;
    }
    if (path.length > 0) {
      paragraphs.push(
        `Requests arrive from the public internet and pass through ${humanList(path)}.`,
      );
    }
  }

  /* ------------------------------------------------------------- by category -- */

  for (const category of CATEGORY_ORDER) {
    const inCategory = resources.filter((n) => n.category === category);
    if (inCategory.length === 0) continue;
    const described = inCategory.map((n) => `${nodeLabel(n)}${attributeClause(n)}`);
    paragraphs.push(
      `${CATEGORY_META[category].label}: ${humanList(described)}.`,
    );
  }

  /* ------------------------------------------------------- explicit topology -- */

  const drawn = model.edges.filter((edge) => {
    if (edge.origin !== "user") return false;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return !!source && !!target && source.kind !== "internet";
  });
  if (drawn.length > 0) {
    const sentences = drawn
      .slice(0, 8)
      .map((edge) => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        return source && target ? `${nodeLabel(source)} ${connection(edge.access)} ${nodeLabel(target)}${whenConditional(edge)}` : "";
      })
      .filter(Boolean);
    paragraphs.push(`${humanList(sentences)}.`);
  }

  /* ----------------------------------------------------------------- flags -- */

  const flagged = model.nodes.filter((n) => n.flag);
  if (flagged.length > 0) {
    const reasons = flagged.map((n) => `${nodeLabel(n)} — ${n.flag?.reason ?? ""}`);
    paragraphs.push(
      `Needs confirming before this becomes code: ${reasons.join(" ")}`,
    );
  } else {
    paragraphs.push("Nothing is left unconfirmed — every component has a decided configuration.");
  }

  return paragraphs.join("\n\n");
}
