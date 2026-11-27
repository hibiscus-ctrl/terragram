// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { attributeOf, extractReferences, type HclBlock, mapEntries, parseHcl, stringValue } from "./hcl.ts";
import {
  isScaffoldModule,
  kindDefinition,
  moduleSourceToKind,
  readSpec,
  resourceTypeToKind,
} from "./kinds.ts";
import { reconcileEdges, uniqueNodeId } from "./engine.ts";
import { ANY_RESOURCE_ID, mergeAccess, readIam, runsAsAddresses } from "./iam.ts";
import type { Cloud, EdgeAccess, InfraModel, ModelEdge, ModelNode } from "./model.ts";

/**
 * Terraform → model. Reads a real document rather than pattern-matching resource
 * headers, so three things survive the trip that used to be thrown away: the
 * attributes a reviewer chose, the topology the file actually declares, and the
 * parts we cannot translate.
 *
 * The rule about topology is the important one. When the file contains references
 * between resources, those references *are* the diagram — we never overwrite them
 * with our own spine guesses. Only a file with no cross-references falls back to
 * derived topology, and in that case we say so rather than pretending we read it.
 */

export type ParseResult =
  | { ok: true; model: InfraModel; cloud: Cloud; untranslated: string[] }
  | { ok: false; error: string };

type Instance = {
  node: ModelNode;
  /** The primary block, whose attributes the inspector reads back. */
  primary: HclBlock | null;
  /** Every block that belongs to this node, for reference scanning. */
  blocks: HclBlock[];
  /** Terraform name the blocks share, e.g. `web`. */
  tfName: string;
};

/** `resource "type" "name"` → its address parts; `module "name"` → `module.name`. */
function resourceLabel(block: HclBlock): { type: string; name: string } | null {
  if (block.type === "module") {
    const [name] = block.labels;
    return name ? { type: "module", name } : null;
  }
  const [type, name] = block.labels;
  return type && name ? { type, name } : null;
}

function moduleSource(block: HclBlock): string {
  return stringValue(attributeOf(block, "source")) ?? "";
}

/** Majority vote on provider prefix (and module namespace), so a mixed file still
 *  picks a target. A tie goes to Azure, then AWS. Google Cloud is read only, so it is the
 *  cloud only for a file with no AWS or Azure in it: a file that has any is for the one of those it has most of. */
function detectCloud(types: string[], sources: string[]): Cloud {
  let azure = 0;
  let aws = 0;
  let gcp = 0;
  for (const type of types) {
    if (type.startsWith("azurerm_") || type.startsWith("azuread_")) azure++;
    if (type.startsWith("aws_")) aws++;
    if (type.startsWith("google_")) gcp++;
  }
  for (const source of sources) {
    if (source.startsWith("Azure/")) azure++;
    if (source.startsWith("terraform-aws-modules/")) aws++;
    if (source.startsWith("terraform-google-modules/") || source.startsWith("GoogleCloudPlatform/")) gcp++;
  }
  if (azure + aws === 0 && gcp > 0) return "gcp";
  return aws > azure ? "aws" : "azure";
}

/** `data.<type>.<name>` inside an expression. */
const DATA_REFERENCE_RE = /\bdata\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g;

/** Every attribute expression in a block and its children. */
function expressions(block: HclBlock): string[] {
  const out = block.attributes.map((a) => a.value);
  // A settings map's values are references too — that is where wiring lands.
  for (const attribute of block.attributes) {
    for (const entry of mapEntries(attribute.value)) out.push(entry.value);
  }
  for (const nested of block.blocks) out.push(...expressions(nested));
  return out;
}

export function parseTerraform(source: string): ParseResult {
  const blocks = parseHcl(source);
  const resources = blocks.filter((b) => b.type === "resource");
  const modules = blocks.filter(
    (b) => b.type === "module" && !isScaffoldModule(b),
  );

  if (resources.length === 0 && modules.length === 0) {
    return { ok: false, error: "No Terraform resource blocks were found in this file." };
  }

  const cloud = detectCloud(
    resources.flatMap((b) => resourceLabel(b)?.type ?? []),
    modules.map(moduleSource),
  );

  // Resolve every resource and module block to a kind, keeping what we could not
  // translate. A module resolves by its registry source, the way a resource does by
  // its type — so Terragram's own module-based output reads back to the same model.
  type Resolved = { block: HclBlock; type: string; name: string; kind: string };
  const resolved: Resolved[] = [];
  const untranslated: string[] = [];
  const unreadModules: HclBlock[] = [];

  for (const block of resources) {
    const label = resourceLabel(block);
    if (!label) continue;
    const match = resourceTypeToKind(label.type, cloud, block) ?? resourceTypeToKind(label.type, undefined, block);
    if (match) resolved.push({ block, ...label, kind: match.kind });
    else untranslated.push(`${label.type}.${label.name}`);
  }
  for (const block of modules) {
    const label = resourceLabel(block);
    if (!label) continue;
    const match = moduleSourceToKind(moduleSource(block), block);
    if (match) resolved.push({ block, ...label, kind: match.kind });
    else unreadModules.push(block);
  }

  if (resolved.length === 0) {
    return {
      ok: false,
      error:
        "None of the resources in this file are ones that can be mapped yet. It reads the AWS, Azure and Google Cloud services in the component palette — compute, networking, storage, identity and monitoring.",
    };
  }

  /* -- one node per primary block, secondary blocks attached to the nearest -- */

  const instances: Instance[] = [];
  const takenIds: string[] = [];

  const byKind = new Map<string, Resolved[]>();
  for (const item of resolved) {
    const list = byKind.get(item.kind);
    if (list) list.push(item);
    else byKind.set(item.kind, [item]);
  }

  for (const [kind, items] of byKind) {
    const spec = readSpec(kind, cloud);
    const def = kindDefinition(kind);
    // A module block is its own primary when it is the kind's module: the whole
    // component is that one call. A module the kind merely `moduleMatches` (the
    // cluster beside an ECS service) attaches to the primary like any secondary.
    const primaries = items.filter(
      (i) =>
        i.type === spec?.type ||
        (i.type === "module" && moduleSource(i.block) === spec?.moduleSource),
    );
    const seeds = primaries.length > 0 ? primaries : [items[0] as Resolved];

    for (const seed of seeds) {
      const id = uniqueNodeId(kind, takenIds);
      takenIds.push(id);
      const node: ModelNode = {
        id,
        category: def?.category ?? "compute",
        kind,
        label: def?.label ?? kind,
        flag: null,
      };
      instances.push({
        node,
        primary: primaries.length > 0 ? seed.block : null,
        blocks: [seed.block],
        tfName: seed.name,
      });
    }

    // Attach the rest: the instance whose Terraform name prefixes this one's,
    // else the first instance of the kind.
    const own = instances.filter((i) => i.node.kind === kind);
    for (const item of items) {
      if (seeds.includes(item)) continue;
      const target =
        own.find((i) => item.name === i.tfName) ??
        own.find((i) => item.name.startsWith(i.tfName)) ??
        own[0];
      target?.blocks.push(item.block);
    }
  }

  // Read reviewer-facing attributes back out of the primary block.
  for (const instance of instances) {
    const spec = readSpec(instance.node.kind, cloud);
    if (!spec?.read || !instance.primary) continue;
    const attributes = spec.read(instance.primary);
    if (Object.keys(attributes).length > 0) instance.node.attributes = attributes;
  }

  /* --------------------------------------------- references become edges -- */

  const ownerByAddress = new Map<string, string>();
  for (const instance of instances) {
    for (const block of instance.blocks) {
      const label = resourceLabel(block);
      if (label) ownerByAddress.set(`${label.type}.${label.name}`, instance.node.id);
    }
  }

  const edges: ModelEdge[] = [];
  const seen = new Set<string>();
  // Every Google Cloud resource names its project; that is where it lives, not a wire to it.
  const projects = new Set(instances.filter((i) => i.node.kind === "project").map((i) => i.node.id));
  for (const instance of instances) {
    for (const block of instance.blocks) {
      for (const expression of expressions(block)) {
        for (const address of extractReferences(expression)) {
          const target = ownerByAddress.get(address);
          if (!target || target === instance.node.id || projects.has(target)) continue;
          const key = `${instance.node.id}->${target}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ id: key, source: instance.node.id, target, origin: "user" });
        }
      }
    }
  }

  /* -- who runs as which identity, and what each identity may reach -- */

  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const typeEdge = (from: string, target: string, access: EdgeAccess, grant: { conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined } = {}) => {
    if (from === target) return;
    const key = `${from}->${target}`;
    const existing = edgeById.get(key);
    if (existing) {
      const merged = mergeAccess(existing, { access, ...grant });
      existing.access = merged.access;
      if (merged.conditional) existing.conditional = true;
      else delete existing.conditional;
      if (merged.unconditional) existing.unconditional = merged.unconditional;
      else delete existing.unconditional;
      return;
    }
    const edge: ModelEdge = {
      id: key,
      source: from,
      target,
      origin: "user",
      access,
      ...(grant.conditional ? { conditional: true } : {}),
      ...(grant.conditional && grant.unconditional ? { unconditional: grant.unconditional } : {}),
    };
    edgeById.set(key, edge);
    edges.push(edge);
  };
  const kindOf = new Map(instances.map((i) => [i.node.id, i.node.kind]));
  for (const instance of instances) {
    if (instance.node.kind === "entra-id") continue;
    for (const address of runsAsAddresses(instance.blocks, blocks)) {
      const identity = ownerByAddress.get(address);
      if (identity && kindOf.get(identity) === "entra-id") typeEdge(instance.node.id, identity, "runs-as");
    }
  }
  const iam = readIam(blocks, (address) => ownerByAddress.get(address), cloud);
  for (const edge of iam.edges) typeEdge(edge.source, edge.target, edge.access, edge);
  for (let i = untranslated.length - 1; i >= 0; i--) {
    const [type, name] = (untranslated[i] ?? "").split(".");
    if ([...iam.consumed].some((b) => b.type === "resource" && b.labels[0] === type && b.labels[1] === name)) {
      untranslated.splice(i, 1);
    }
  }

  /* -- untranslated modules and data sources stay on the diagram, flagged -- */

  // A data source a translated component reads is part of that component — the
  // account its key policy names, the managed policy its CDN attaches — not a
  // block of its own. One that nothing translated reads stays on the diagram.
  const readByComponents = new Set(
    instances
      .flatMap((i) => i.blocks.flatMap(expressions))
      .flatMap((expression) => [...expression.matchAll(DATA_REFERENCE_RE)].map((m) => `${m[1]}.${m[2]}`)),
  );
  const nodes = instances.map((i) => i.node);
  // An unscoped grant has to end somewhere on the picture: one conceptual node for "any resource".
  if (edges.some((e) => e.target === ANY_RESOURCE_ID)) {
    nodes.push({ id: ANY_RESOURCE_ID, category: "edge", kind: "external", label: "Any resource (*)", flag: null });
  }
  // A grant from a principal the picture does not draw starts at a stand-in for its kind, in fixed words.
  for (const [id, label] of iam.principals) {
    if (edges.some((e) => e.source === id)) nodes.push({ id, category: "edge", kind: "external", label, flag: null });
  }
  for (const block of blocks) {
    if (block.type === "module" ? !unreadModules.includes(block) : block.type !== "data") continue;
    if (block.type === "module" && isScaffoldModule(block)) continue;
    if (block.type === "data" && (readByComponents.has(block.labels.join(".")) || iam.consumed.has(block))) continue;
    const name = block.labels.at(-1) ?? block.type;
    const id = uniqueNodeId(`external-${name}`, takenIds);
    takenIds.push(id);
    nodes.push({
      id,
      category: "edge",
      kind: "external",
      label: `${block.type} ${name}`,
      flag: { reason: `This ${block.type} block was read but its contents cannot be translated.` },
    });
    untranslated.push(`${block.type}.${name}`);
  }

  /* ---------------------------------------------------- ingress + assembly -- */

  const hasReferences = edges.length > 0;
  const internet: ModelNode = {
    id: "internet",
    category: "edge",
    kind: "internet",
    label: "Internet",
    flag: null,
  };

  if (hasReferences) {
    // The file's own wiring is the topology. Mark it manual so no later turn
    // re-derives it, and hang the conceptual internet node off the entry point.
    const entry = entryPoint(nodes, edges);
    const all = [internet, ...nodes];
    if (entry) {
      edges.unshift({
        id: `internet->${entry}`,
        source: internet.id,
        target: entry,
        origin: "derived",
      });
    }
    return { ok: true, model: { nodes: all, edges, topology: "manual" }, cloud, untranslated };
  }

  const derived = reconcileEdges({
    nodes: [internet, ...nodes],
    edges: [],
    topology: "derived",
  });
  return { ok: true, model: derived, cloud, untranslated };
}

/** The node nothing else points at — where traffic enters the parsed graph. */
function entryPoint(nodes: ModelNode[], edges: ModelEdge[]): string | undefined {
  const consumed = new Set(edges.map((e) => e.target));
  // A Google Cloud project is where everything lives, not where a request enters.
  const enters = (n: ModelNode) => !consumed.has(n.id) && n.category !== "edge" && n.kind !== "project";
  return nodes.find(enters)?.id ?? nodes.find((n) => n.kind !== "project")?.id ?? nodes[0]?.id;
}
