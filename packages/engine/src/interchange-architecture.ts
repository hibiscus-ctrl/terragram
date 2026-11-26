// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type GraphBox, type GraphLink, buildGraphModel } from "./graph-build.ts";
import type { InfraModel } from "./model.ts";

/**
 * Mermaid `architecture-beta` diagram → model.
 *
 * The same promises as the flowchart reader (`interchange.ts`): every service lands
 * on the diagram, every edge survives as a connection the reviewer owns, nothing is
 * guessed. What differs is the vocabulary, taken from Mermaid's architecture syntax
 * (https://mermaid.js.org/syntax/architecture.html):
 *
 *   group    id(icon)[Title] (in parent)?
 *   service  id(icon)[Title] (in parent)?
 *   junction id (in parent)?
 *   edge     a{group}?:R <?--?> L:b{group}?        (sides are L, R, T or B)
 *
 * What is read and how:
 * - **Services** become components. The label is matched to a kind through the same
 *   registry keywords as a flowchart box. The icon never chooses a kind. The built-in
 *   `internet` icon is the outside world (the model's internet node); `cloud`,
 *   `database`, `disk` and `server` say what shape a box has, not which resource it is,
 *   so the label decides. Any other icon (an Iconify name such as `logos:aws-lambda`)
 *   is not in a map this engine can trust, so the service stays a flagged generic
 *   component and a warning says so; its label is not matched either.
 * - **Groups** are read for their nesting and dropped: the model has no group, so
 *   each one is reported as a warning and its services are kept.
 * - **Junctions** are not components. Every edge into a junction is joined to every
 *   edge out of it, so `a -> j`, `j -> b` and `j -> c` read as `a -> b` and `a -> c`.
 * - **Edges** run from the left operand to the right one, as a flowchart's `---` does;
 *   `<--` reverses it, and `<-->` is kept as one edge in written order. The sides
 *   (`L`/`R`/`T`/`B`) only steer Mermaid's drawing and are validated, not kept.
 *
 * Anything else is an error that names the line: a half-read diagram that looks
 * complete is worse than a refusal.
 */

export type ArchitectureResult =
  | { ok: true; model: InfraModel; untranslated: string[]; warnings: string[] }
  | { ok: false; error: string };

const HEADER = /^architecture-beta\b/;

/** Icons Mermaid draws without a registered icon pack. */
const BUILT_IN_ICONS: ReadonlySet<string> = new Set(["cloud", "database", "disk", "internet", "server"]);

const ID = "[\\w-]+";
const DECLARATION = new RegExp(
  `^(group|service)\\s+(${ID})\\s*(?:\\(([^)]*)\\))?\\s*(?:\\[([^\\]]*)\\])?(?:\\s+in\\s+(${ID}))?$`,
);
const JUNCTION = new RegExp(`^junction\\s+(${ID})(?:\\s+in\\s+(${ID}))?$`);
const EDGE = new RegExp(
  `^(${ID})(\\{group\\})?:([LRTB])\\s*(<)?--(>)?\\s*([LRTB]):(${ID})(\\{group\\})?$`,
);

/** Lines that carry no structure. `accDescr {` opens a block that runs to `}`. */
const IGNORED = /^(title\b|accTitle\b|accDescr\s*:)/;
const ACC_BLOCK = /^accDescr\s*\{\s*$/;

type Entity = {
  kind: "group" | "service" | "junction";
  id: string;
  title: string;
  icon: string | null;
  parent: string | null;
};

function fail(line: number, message: string): ArchitectureResult {
  return { ok: false, error: `Line ${line}: ${message}` };
}

function unquote(text: string): string {
  const trimmed = text.trim();
  const quoted = trimmed.match(/^(["'`])(.*)\1$/);
  return (quoted ? (quoted[2] ?? "") : trimmed).replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
}

export function looksLikeArchitecture(source: string): boolean {
  const first = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("%%"));
  return first !== undefined && HEADER.test(first);
}

export function parseArchitecture(source: string): ArchitectureResult {
  const lines = source.split(/\r?\n/);
  const entities = new Map<string, Entity>();
  const order: Entity[] = [];
  /** Directed pairs between services and junctions, in document order. */
  const edges: Array<{ from: string; to: string }> = [];
  const warnings: string[] = [];

  let sawHeader = false;
  let inAccBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const number = index + 1;
    const line = (lines[index] ?? "").replace(/%%.*$/, "").trim().replace(/;$/, "");
    if (!line) continue;
    if (inAccBlock) {
      if (line === "}") inAccBlock = false;
      continue;
    }
    if (!sawHeader) {
      // The caller has checked that the first line starts with the header.
      if (line !== "architecture-beta") {
        return fail(number, `nothing may follow \`architecture-beta\` on its line, found "${line}".`);
      }
      sawHeader = true;
      continue;
    }
    if (IGNORED.test(line)) continue;
    if (ACC_BLOCK.test(line)) {
      inAccBlock = true;
      continue;
    }

    const declaration = line.match(DECLARATION);
    const junction = declaration ? null : line.match(JUNCTION);
    if (declaration || junction) {
      const kind = declaration ? (declaration[1] as "group" | "service") : "junction";
      const id = (declaration ? declaration[2] : junction?.[1]) as string;
      const parentId = (declaration ? declaration[5] : junction?.[2]) ?? null;
      if (entities.has(id)) return fail(number, `"${id}" is declared twice.`);
      if (parentId !== null) {
        const parent = entities.get(parentId);
        if (!parent) return fail(number, `"${id}" is placed in "${parentId}", which is not declared above it.`);
        if (parent.kind !== "group") return fail(number, `"${id}" is placed in "${parentId}", which is not a group.`);
      }
      const title = declaration?.[4] === undefined ? "" : unquote(declaration[4]);
      const icon = declaration?.[3] === undefined ? null : declaration[3].trim();
      const entity: Entity = { kind, id, title, icon: icon || null, parent: parentId };
      entities.set(id, entity);
      order.push(entity);
      continue;
    }

    const edge = line.match(EDGE);
    if (edge) {
      const [, left, leftGroup, , leftArrow, rightArrow, , right, rightGroup] = edge;
      for (const [id, group] of [
        [left, leftGroup],
        [right, rightGroup],
      ] as const) {
        const entity = entities.get(id as string);
        if (!entity) return fail(number, `the edge uses "${id}", which is not declared above it.`);
        if (entity.kind === "group") {
          return fail(number, `"${id}" is a group; an edge names a service or junction (use \`service{group}\` to leave a group).`);
        }
        if (group && entity.parent === null) {
          return fail(number, `"${id}{group}" is not in a group, so the {group} modifier cannot be used on it.`);
        }
      }
      // `<--` points at the left operand; everything else reads left to right.
      const reversed = leftArrow === "<" && rightArrow !== ">";
      const [from, to] = reversed ? [right, left] : [left, right];
      if (from === to) return fail(number, `"${from}" is connected to itself.`);
      if (leftArrow === "<" && rightArrow === ">") {
        warnings.push(
          `line ${number}: "${left} <--> ${right}" is kept as one connection from ${left} to ${right}; the model's edges have a direction.`,
        );
      }
      edges.push({ from: from as string, to: to as string });
      continue;
    }

    return fail(number, `cannot read "${line}". Expected group, service, junction or an edge such as \`a:R -- L:b\`.`);
  }

  const services = order.filter((entity) => entity.kind === "service");
  if (services.length === 0) return { ok: false, error: "No services were found in this architecture diagram." };

  const titleOf = (entity: Entity): string => entity.title || entity.id;
  for (const group of order.filter((entity) => entity.kind === "group")) {
    const members = services.filter((service) => within(entities, service, group.id)).length;
    const parent = group.parent === null ? "" : ` (in "${titleOf(entities.get(group.parent) as Entity)}")`;
    warnings.push(
      `group "${titleOf(group)}"${parent} is not kept: the model has no groups. Its ${members} service${members === 1 ? "" : "s"} ${members === 1 ? "is" : "are"} kept.`,
    );
  }

  const boxes: GraphBox[] = services.map((service) => {
    const label = service.title || service.id;
    if (service.icon === "internet") return { ref: service.id, label, kind: "internet" };
    if (service.icon === null || BUILT_IN_ICONS.has(service.icon)) return { ref: service.id, label };
    const reason = `The icon "${service.icon}" is not one of Mermaid's built-in icons (cloud, database, disk, internet, server), so "${label}" was not matched to a component. Pick a kind for it, or leave it as documentation.`;
    warnings.push(
      `service "${service.id}": icon "${service.icon}" is not a built-in icon; kept as a generic component, not matched to a resource kind.`,
    );
    return { ref: service.id, label, generic: true, flagReason: reason };
  });

  const links = throughJunctions(
    edges,
    order.filter((entity) => entity.kind === "junction").map((entity) => entity.id),
    warnings,
  );
  return { ok: true, ...buildGraphModel(boxes, links), warnings };
}

/** Whether `entity` sits in `groupId`, directly or through nested groups. */
function within(entities: Map<string, Entity>, entity: Entity, groupId: string): boolean {
  for (let at = entity.parent; at !== null; at = entities.get(at)?.parent ?? null) {
    if (at === groupId) return true;
  }
  return false;
}

/**
 * Replace each junction by the connections that run through it: every edge in is
 * joined to every edge out. Junctions are taken in declaration order, so a chain of
 * them resolves the same way every time. A junction with edges on one side only
 * connects nothing and says so.
 */
function throughJunctions(
  edges: Array<{ from: string; to: string }>,
  junctions: string[],
  warnings: string[],
): GraphLink[] {
  let links = edges;
  for (const junction of junctions) {
    const into = links.filter((link) => link.to === junction);
    const out = links.filter((link) => link.from === junction);
    if ((into.length === 0) !== (out.length === 0)) {
      warnings.push(
        `junction "${junction}" has edges ${into.length === 0 ? "out of" : "into"} it only, so it joins nothing and its edges are dropped.`,
      );
    }
    const rest = links.filter((link) => link.to !== junction && link.from !== junction);
    const through: Array<{ from: string; to: string }> = [];
    for (const a of into) {
      for (const b of out) if (a.from !== b.to) through.push({ from: a.from, to: b.to });
    }
    links = [...rest, ...through];
  }
  return links;
}
