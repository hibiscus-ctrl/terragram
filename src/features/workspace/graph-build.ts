import { matchKinds, uniqueNodeId } from "./engine.ts";
import { kindDefinition, MODEL_KIND_IDS } from "./kinds.ts";
import type { InfraModel, ModelEdge, ModelNode } from "./model.ts";

/**
 * Boxes and arrows → model. Shared by every importer that reads a picture of an
 * architecture — a Mermaid flowchart, a screenshot — so they all keep the same
 * promises: every box lands on the diagram (as a component when it can be named,
 * flagged when it cannot), every arrow survives as a connection the reviewer owns,
 * and the arrows ARE the topology, so nothing re-derives what the author drew.
 */

export type GraphBox = {
  /** The importer's own handle for the box — a Mermaid id, a model's ref. */
  ref: string;
  label: string;
  /** A kind the importer already knows; validated, then label-matched if absent. */
  kind?: string | null;
  /** The importer's reason for being unsure, raised as a review flag. */
  flagReason?: string | null;
};

export type GraphLink = { from: string; to: string };

export type BuiltGraph = { model: InfraModel; untranslated: string[] };

/** Labels that mean "the outside world", drawn as the conceptual internet node. */
const CONCEPTUAL = /^(internet|users?|clients?|browsers?|public|end users?|the web|the internet)$/i;

const INTERNET: ModelNode = { id: "internet", category: "edge", kind: "internet", label: "Internet", flag: null };

export function buildGraphModel(boxes: GraphBox[], links: GraphLink[]): BuiltGraph {
  const idFor = new Map<string, string>();
  const nodes: ModelNode[] = [];
  const untranslated: string[] = [];
  const taken: string[] = [];
  let hasInternet = false;

  for (const box of boxes) {
    const label = box.label.trim() || box.ref;

    if (CONCEPTUAL.test(label) || box.kind === "internet") {
      hasInternet = true;
      idFor.set(box.ref, INTERNET.id);
      continue;
    }

    const kind =
      box.kind && MODEL_KIND_IDS.includes(box.kind) ? box.kind : matchKinds(`${label} ${box.ref}`)[0];
    if (kind) {
      const def = kindDefinition(kind);
      const id = uniqueNodeId(kind, taken);
      taken.push(id);
      idFor.set(box.ref, id);
      nodes.push({
        id,
        category: def?.category ?? "compute",
        kind,
        label: label.slice(0, 160),
        flag: box.flagReason ? { reason: box.flagReason.slice(0, 400) } : (def?.flag ?? null),
      });
      continue;
    }

    const id = uniqueNodeId(`external-${box.ref.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, taken);
    taken.push(id);
    idFor.set(box.ref, id);
    nodes.push({
      id,
      category: "edge",
      kind: "external",
      label: label.slice(0, 160),
      flag: {
        reason: `"${label}" does not match a component Terragram can generate. Pick a kind for it, or leave it as documentation.`,
      },
    });
    untranslated.push(label);
  }

  const edges: ModelEdge[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const source = idFor.get(link.from);
    const target = idFor.get(link.to);
    if (!source || !target || source === target) continue;
    const key = `${source}->${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The author drew the arrow; it is theirs — except the one from the outside
    // world, which is orientation rather than architecture.
    edges.push({ id: key, source, target, origin: source === INTERNET.id ? "derived" : "user" });
  }

  // A picture without an outside-world box still needs one to orient the reader,
  // hung off whatever nothing else points at.
  if (!hasInternet) {
    const consumed = new Set(edges.map((e) => e.target));
    const entry = nodes.find((n) => !consumed.has(n.id) && n.kind !== "external") ?? nodes[0];
    if (entry) edges.unshift({ id: `internet->${entry.id}`, source: INTERNET.id, target: entry.id, origin: "derived" });
  }

  return { model: { nodes: [INTERNET, ...nodes], edges, topology: "manual" }, untranslated };
}
