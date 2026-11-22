// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { matchKinds } from "./engine.ts";
import { cloudSpec, KIND_LABELS } from "./kinds.ts";
import type { Cloud, InfraModel, ModelNode } from "./model.ts";

/**
 * Can what the model shows actually be built? One answer, from the model alone,
 * used everywhere the question is asked: after a picture or a flowchart is read, at
 * the review gate, and in the receipt.
 *
 * The rule is the same rule the emitter applies — a node is built when its kind has
 * a spec for the target cloud — stated up front instead of discovered by noticing a
 * box is missing from the plan. A component the reader could not name is reported
 * as such, with the nearest kind its label suggests, so the reviewer can pick one
 * or knowingly leave it as documentation.
 */

type ComponentVerdict = {
  id: string;
  label: string;
  kind: string;
  status: "buildable" | "needs-review" | "unsupported";
  /** Why the reviewer's attention is needed, when it is. */
  reason: string | null;
  /** A kind the label suggests, for an unsupported component. */
  suggestion: string | null;
};

export type Feasibility = {
  /** `full` — every component builds; `partial` — some will be omitted; `none`. */
  verdict: "full" | "partial" | "none";
  components: ComponentVerdict[];
  /** Labels of components generation will leave out. */
  omitted: string[];
  /** Plain English, ready to be the assistant's reply. */
  summary: string;
};

function isConceptualEdge(node: ModelNode): boolean {
  return node.kind === "internet";
}

/**
 * Things a diagram commonly shows that are not in the registry's vocabulary but
 * have an obvious nearest kind. The importer's own keyword match already ran on
 * the label and found nothing, so this is the second opinion, offered as a
 * suggestion the reviewer confirms — never applied silently.
 *
 * The first matching row wins, so specific rows come before the generic `server`
 * one ("SFTP server" is storage, not a VM). A bare "gateway" or "instance" is not
 * enough on its own: a NAT gateway is networking, a payment gateway is a third
 * party, and an instance profile is IAM.
 */
const NEAREST: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  { pattern: /\b(?:kafka|kinesis|event ?hubs?|rabbit ?mq|amqp|topic)\b/i, kind: "queue" },
  { pattern: /\b(?:opensearch|elasticsearch|search index)\b/i, kind: "nosql" },
  { pattern: /\b(?:sftp|file share|nfs|efs)\b/i, kind: "object-storage" },
  { pattern: /\b(?:nat gateway|internet gateway|transit gateway)\b/i, kind: "vnet" },
  { pattern: /\b(?:api gateway|reverse proxy)\b/i, kind: "front-door" },
  { pattern: /\b(?:vm|virtual machine|ec2|server)\b/i, kind: "app-service" },
];

function suggestionFor(node: ModelNode): string | null {
  return matchKinds(node.label)[0] ?? NEAREST.find((n) => n.pattern.test(node.label))?.kind ?? null;
}

export function assessFeasibility(model: InfraModel, cloud: Cloud): Feasibility {
  const components: ComponentVerdict[] = [];
  for (const node of model.nodes) {
    if (isConceptualEdge(node)) continue;
    const buildable = cloudSpec(node.kind, cloud) !== null;
    if (!buildable) {
      components.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        status: "unsupported",
        reason: node.flag?.reason ?? "No matching component in the component vocabulary.",
        suggestion: suggestionFor(node),
      });
      continue;
    }
    components.push({
      id: node.id,
      label: node.label,
      kind: node.kind,
      status: node.flag ? "needs-review" : "buildable",
      reason: node.flag?.reason ?? null,
      suggestion: null,
    });
  }

  const omitted = components.filter((c) => c.status === "unsupported").map((c) => c.label);
  const built = components.length - omitted.length;
  const verdict = components.length === 0 || built === 0 ? "none" : omitted.length > 0 ? "partial" : "full";
  const cloudLabel = cloud === "aws" ? "AWS" : "Azure";
  const review = components.filter((c) => c.status === "needs-review").length;

  let summary: string;
  if (verdict === "none") {
    summary =
      components.length === 0
        ? "Nothing in this diagram maps to a component it can build."
        : `None of the ${components.length} components map to something it can build on ${cloudLabel}.`;
  } else if (verdict === "full") {
    summary = `All ${built} components can be built on ${cloudLabel}.`;
  } else {
    summary = `${built} of ${components.length} components can be built on ${cloudLabel}. Not buildable: ${omitted.join(", ")}.`;
    const hints = components
      .filter((c) => c.status === "unsupported" && c.suggestion)
      .map((c) => `${c.label} could be ${KIND_LABELS[c.suggestion ?? ""] ?? c.suggestion}`);
    if (hints.length > 0) summary += ` ${hints.join("; ")} — pick a kind in the inspector to include it.`;
  }
  if (review > 0) {
    summary += ` ${review} ${review === 1 ? "component needs" : "components need"} review before generating.`;
  }

  return { verdict, components, omitted, summary };
}
