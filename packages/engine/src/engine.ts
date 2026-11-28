// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { ManagedModelId } from "./managed-models.ts";
import {
  fieldsForKind,
  INGRESS_ORDER,
  isFronted,
  KIND_BY_ID,
  kindDefinition,
  SERVING_KINDS,
} from "./kinds.ts";
import {
  type Cloud,
  EMPTY_MODEL,
  type InfraModel,
  type ModelEdge,
  type ModelNode,
} from "./model.ts";

/**
 * The deterministic translator: plain English in, model out, with no network and no
 * randomness. It is the availability floor under managed inference — when the
 * gateway is off or unreachable a turn still gets an answer — so it recognises the
 * same vocabulary the managed engine does, coarsely, by keyword.
 *
 * Every resource fact it needs comes from the kind registry (`kinds.ts`). This file
 * only owns the shape of the graph: which nodes form the ingress spine, what hangs
 * off the application tier, and how a turn is described back to the user.
 */

export { MODEL_KIND_IDS } from "./kinds.ts";

/** Which translator produced a turn — surfaced honestly (the evidence summary labels
 *  it) so a managed badge never claims managed inference when the
 *  deterministic keyword engine actually answered. */
export type EngineKind = "managed" | "deterministic";

export type ComposeResult = {
  model: InfraModel;
  /** Assistant reply describing what changed. */
  reply: string;
  /** Labels of nodes added this turn — empty when the prompt added nothing new. */
  added: string[];
  /** The translator that produced this turn. */
  engine: EngineKind;
  /** The managed model that produced it, when one did. Carried so the evidence
   *  receipt can record what actually ran rather than what is configured now. */
  inferenceModel?: ManagedModelId;
  /** The cloud the brief named ("deploy a lambda to AWS"), when it named one. The
   *  workspace switches its target to match; absent, the target stays as it was. */
  cloud?: Cloud;
};

/**
 * One component a translator asks for. The managed engine may supply reviewer-facing
 * detail alongside the kind — a friendlier label, attribute choices it inferred, and
 * an honest reason it is unsure — so a managed turn can raise its own review flag
 * rather than only the two the registry hardcodes.
 */
export type ComponentRequest = {
  kind: string;
  label?: string;
  attributes?: Record<string, string>;
  flagReason?: string;
};

function normalize(input: string | ComponentRequest): ComponentRequest {
  return typeof input === "string" ? { kind: input } : input;
}

/** A node id that is free in `taken`: `postgres`, then `postgres-2`, `postgres-3`. */
export function uniqueNodeId(kind: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

function nodeFromRequest(request: ComponentRequest, id: string): ModelNode {
  const def = kindDefinition(request.kind);
  const flag = request.flagReason
    ? { reason: request.flagReason.slice(0, 400) }
    : (def?.flag ?? null);
  const node: ModelNode = {
    id,
    category: def?.category ?? "compute",
    kind: request.kind,
    label: request.label?.slice(0, 160) || (def?.label ?? request.kind),
    flag,
  };
  const attributes = validAttributes(request.kind, request.attributes);
  return attributes ? { ...node, attributes } : node;
}

/**
 * Keep only attribute keys the registry declares for this kind, and only values it
 * offers. A managed model choosing a value outside the field's options would emit
 * HCL the provider rejects, so an unknown value is dropped rather than trusted.
 */
function validAttributes(
  kind: string,
  attributes: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attributes) return undefined;
  const fields = kindDefinition(kind)?.fields ?? [];
  const kept: Record<string, string> = {};
  for (const field of fields) {
    const value = attributes[field.key];
    if (value === undefined) continue;
    if (field.options && !field.options.includes(value)) continue;
    kept[field.key] = value.slice(0, 120);
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/* ------------------------------------------------------------------- spine -- */

type Spine = { ingress: ModelNode[]; serving: ModelNode[]; leaves: ModelNode[] };

/** Split the model's nodes into the three tiers the derived topology connects. */
function tiers(nodes: ModelNode[]): Spine {
  const roleOf = (node: ModelNode) => KIND_BY_ID.get(node.kind)?.role ?? "leaf";
  const ingress = nodes
    .filter((n) => roleOf(n) === "ingress" || roleOf(n) === "conceptual")
    .sort((a, b) => INGRESS_ORDER.indexOf(a.kind) - INGRESS_ORDER.indexOf(b.kind));
  const serving = nodes.filter((n) => roleOf(n) === "serving");
  // An untranslated block still belongs on the diagram, hung off the app tier like
  // any other dependency — hiding it would be the one thing worse than not reading it.
  const leaves = nodes.filter((n) => roleOf(n) === "leaf" || roleOf(n) === "external");
  return { ingress, serving, leaves };
}

/**
 * Rebuild the derived edges from the tier rules: the ingress kinds chain in order,
 * every application tier hangs off the last ingress node, and every leaf hangs off
 * the first application tier. Edges the reviewer drew themselves are preserved
 * untouched, and once the topology is `manual` nothing is re-derived at all.
 */
function rebuildEdges(nodes: ModelNode[], previous: ModelEdge[], manual: boolean): ModelEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const userEdges = previous.filter((e) => e.origin === "user" && ids.has(e.source) && ids.has(e.target));

  if (manual) {
    const kept = previous.filter((e) => ids.has(e.source) && ids.has(e.target));
    const known = new Set(kept.map((e) => `${e.source}->${e.target}`));
    // A node added by chat after the topology went manual still needs an anchor,
    // or it would float unconnected. Connect it once, then leave it alone.
    const { ingress, serving } = tiers(nodes);
    const anchor = serving[0]?.id ?? ingress.at(-1)?.id;
    const orphans = nodes.filter(
      (n) => n.id !== anchor && !kept.some((e) => e.source === n.id || e.target === n.id),
    );
    const added = anchor
      ? orphans.map((n) => ({ id: `${anchor}->${n.id}`, source: anchor, target: n.id, origin: "derived" as const }))
      : [];
    return [...kept, ...added.filter((e) => !known.has(`${e.source}->${e.target}`))];
  }

  const { ingress, serving, leaves } = tiers(nodes);
  const derived: ModelEdge[] = [];
  const connect = (source: string, target: string) => {
    derived.push({ id: `${source}->${target}`, source, target, origin: "derived" });
  };

  for (let i = 0; i < ingress.length - 1; i++) {
    const from = ingress[i];
    const to = ingress[i + 1];
    if (from && to) connect(from.id, to.id);
  }

  const lastIngress = ingress.at(-1)?.id;
  if (lastIngress) for (const node of serving) connect(lastIngress, node.id);

  const anchor = serving[0]?.id ?? lastIngress;
  if (anchor) for (const node of leaves) connect(anchor, node.id);

  const derivedKeys = new Set(derived.map((e) => `${e.source}->${e.target}`));
  return [...derived, ...userEdges.filter((e) => !derivedKeys.has(`${e.source}->${e.target}`))];
}

/**
 * Fold a set of requested components into the model: keep the ingress spine
 * coherent, add the requested components, and re-derive the topology. Shared by the
 * keyword engine and managed inference so both always produce a graph the Terraform
 * emitter understands.
 *
 * The scaffold adds an application tier only when the request does not already name
 * one, so "a containerised API" gets containers rather than containers bolted onto
 * an App Service nobody asked for.
 */
export function assembleModel(
  components: Iterable<string | ComponentRequest>,
  prev: InfraModel = EMPTY_MODEL,
  forceScaffold = false,
): { model: InfraModel; added: string[] } {
  const nodes = [...prev.nodes];
  const present = new Set(nodes.map((n) => n.kind));
  const added: string[] = [];

  const requested = [...components]
    .map(normalize)
    .filter((c) => KIND_BY_ID.has(c.kind) && c.kind !== "internet");

  const ensure = (request: ComponentRequest): boolean => {
    if (present.has(request.kind)) return false;
    const node = nodeFromRequest(request, uniqueNodeId(request.kind, nodes.map((n) => n.id)));
    nodes.push(node);
    present.add(request.kind);
    added.push(node.label);
    return true;
  };

  const wantsScaffold = forceScaffold || requested.length > 0 || nodes.length > 0;
  if (wantsScaffold) {
    ensure({ kind: "internet" });
    const servingRequested = requested.filter((c) => SERVING_KINDS.includes(c.kind));
    const servingPresent = nodes.filter((n) => SERVING_KINDS.includes(n.kind));
    const namesServingTier = servingRequested.length > 0 || servingPresent.length > 0;
    // The edge tier is added for a tier that is meant to sit behind one. A design
    // whose only compute is functions gets the function URL the module gives it;
    // "deploy a lambda" is not a request for a CDN.
    const fronted =
      !namesServingTier ||
      servingRequested.some((c) => isFronted(c.kind)) ||
      servingPresent.some((n) => isFronted(n.kind)) ||
      requested.some((c) => c.kind === "front-door");
    if (fronted) ensure({ kind: "front-door" });
    if (!namesServingTier) ensure({ kind: "app-service" });
  }

  for (const request of requested) ensure(request);

  return {
    model: {
      nodes,
      edges: rebuildEdges(nodes, prev.edges, prev.topology === "manual"),
      topology: prev.topology,
    },
    // The conceptual internet node orients the diagram; it is not something the
    // user asked for, so a turn never reports having "added" it.
    added: added.filter((label) => label !== "Internet"),
  };
}

/** Re-derive edges after a structural change (an add or delete on the canvas). */
export function reconcileEdges(model: InfraModel): InfraModel {
  return {
    ...model,
    edges: rebuildEdges(model.nodes, model.edges, model.topology === "manual"),
  };
}

/* ----------------------------------------------------------------- compose -- */

/** Build the assistant's natural-language reply for a turn that added `added`. */
export function describeTurn(added: string[], model: InfraModel): string {
  if (added.length === 0) {
    return "The model already covers that. Nothing changed — refine or switch modes when you're ready.";
  }
  const components = model.nodes.filter((n) => n.category !== "edge").length;
  const flags = model.nodes.filter((n) => n.flag).length;
  let reply = `I've added ${humanList(added)}. The model now has ${components} ${components === 1 ? "component" : "components"}.`;
  if (flags > 0) {
    reply += ` ${flags} ${flags === 1 ? "attribute needs" : "attributes need"} review before generating code.`;
  }
  return reply;
}

/** Escape a keyword for use inside a whole-word match. */
function keywordPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

const KEYWORD_MATCHERS: ReadonlyArray<{ kind: string; matchers: RegExp[]; weight: number }> = [
  ...KIND_BY_ID.values(),
]
  .filter((def) => def.keywords.length > 0)
  .map((def) => ({
    kind: def.kind,
    matchers: def.keywords.map(keywordPattern),
    // Longer keywords are more specific: "load balancer" should win over "app".
    weight: Math.max(...def.keywords.map((k) => k.length)),
  }))
  .sort((a, b) => b.weight - a.weight);

/**
 * Every kind whose keywords appear in `text`, most specific first. Whole-word
 * matching keeps the greedy short keywords ("web", "app", "db") from firing inside
 * unrelated words, which matters now that the vocabulary is wide enough for them to
 * collide. Shared with the diagram importer so a label and a prompt land on the
 * same kind.
 */
export function matchKinds(text: string): string[] {
  return KEYWORD_MATCHERS.filter((entry) => entry.matchers.some((re) => re.test(text))).map(
    (entry) => entry.kind,
  );
}

/**
 * The cloud a brief names, if it names one. Provider names and the services that
 * belong to exactly one cloud both count; a brief that names neither returns null
 * and the caller keeps its current target.
 */
const CLOUD_HINTS: ReadonlyArray<{ cloud: Cloud; pattern: RegExp }> = [
  {
    cloud: "aws",
    pattern:
      /\b(?:aws|amazon web services|amazon|lambda|s3|dynamodb|ec2|cloudfront|route ?53|sqs|rds|ecs|eks|fargate|cloudwatch)\b/i,
  },
  {
    cloud: "azure",
    pattern: /\b(?:azure|entra|cosmos(?:db)?|app service|front door|service bus|key vault|aks|blob storage)\b/i,
  },
  {
    cloud: "gcp",
    pattern:
      /\b(?:gcp|google cloud|google|gke|cloud run|cloud sql|cloud functions?|bigquery|pub\/?sub|firestore|memorystore|gcs|secret manager|cloud kms|cloud dns|cloud storage)\b/i,
  },
];

export function detectCloud(text: string): Cloud | null {
  const hits = CLOUD_HINTS.filter((h) => h.pattern.test(text)).map((h) => h.cloud);
  if (hits.length === 1) return hits[0] ?? null;
  // Several named ("move from Azure to AWS"): the latest mention is the destination.
  if (hits.length > 1) {
    const last = (cloud: Cloud) => {
      const re = new RegExp(CLOUD_HINTS.find((h) => h.cloud === cloud)?.pattern.source ?? "", "gi");
      let at = -1;
      for (const m of text.matchAll(re)) at = m.index ?? at;
      return at;
    };
    return hits.reduce((best, cloud) => (last(cloud) > last(best) ? cloud : best));
  }
  return null;
}

/**
 * Attribute choices a brief states outright ("powered by Python", "Postgres 15"),
 * read against the kind's declared prompt patterns. Anything the brief does not
 * say stays unset, so the inspector still shows the fallback rather than a guess.
 */
export function attributesFromPrompt(kind: string, prompt: string): Record<string, string> | undefined {
  const chosen: Record<string, string> = {};
  for (const field of fieldsForKind(kind)) {
    const hit = field.prompt?.find((p) => p.pattern.test(prompt));
    if (hit) chosen[field.key] = hit.option;
  }
  return Object.keys(chosen).length > 0 ? chosen : undefined;
}

/** Fold a plain-English instruction into the model by keyword. */
export function composeFromPrompt(prompt: string, prev: InfraModel = EMPTY_MODEL): ComposeResult {
  const matched = matchKinds(prompt);

  // "A containerised API" names one application tier, not two. Keyword matching sees
  // both "containerised" and "api", so among serving kinds keep only the most
  // specific match — the list is already ordered by keyword length. A design that
  // genuinely has several compute tiers is what managed inference is for; guessing
  // one here is better than inventing an App Service nobody asked for.
  const alreadyServing = prev.nodes.some((n) => SERVING_KINDS.includes(n.kind));
  let seenServing = alreadyServing;
  const detected = matched.filter((kind) => {
    if (!SERVING_KINDS.includes(kind)) return true;
    if (seenServing) return false;
    seenServing = true;
    return true;
  });

  const forceScaffold = /architecture|infrastructure|platform|stack/i.test(prompt);
  const requests: ComponentRequest[] = detected.map((kind) => {
    const attributes = attributesFromPrompt(kind, prompt);
    return attributes ? { kind, attributes } : { kind };
  });
  const { model, added } = assembleModel(requests, prev, forceScaffold);
  const cloud = detectCloud(prompt);
  const read = requests
    .flatMap((r) => Object.entries(r.attributes ?? {}).map(([, v]) => v));
  let reply = describeTurn(added, model);
  const facts = [
    ...(cloud ? [`targeting ${cloud === "aws" ? "AWS" : cloud === "gcp" ? "Google Cloud" : "Azure"}`] : []),
    ...read,
  ];
  if (facts.length > 0) reply += ` I read ${humanList(facts)} from your brief.`;
  return { model, reply, added, engine: "deterministic", ...(cloud ? { cloud } : {}) };
}

function humanList(items: string[]): string {
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
