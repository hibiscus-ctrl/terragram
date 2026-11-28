// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type Cloud, EDGE_ACCESS_META, type EdgeAccess, edgeAccessLabel, type ModelEdge, type ModelNode, selfAccessLabel, selfAccessPhrase } from "terragram-engine/model";
import { PUBLIC_PRINCIPAL_IDS, strongerAccess, unconditionalLevel } from "terragram-engine/iam";

import { COMMENT_MARKER } from "./comment.ts";
import type { Inputs } from "./inputs.ts";
import type { Diagram } from "./mermaid.ts";
import { hasModelChanges, type ModelDiff, onlySelfAccessChanged } from "./model-diff.ts";
import type { FileState } from "./terraform-files.ts";

/**
 * The markdown the Action reports with: the sticky pull-request comment and the job's
 * step summary are the same text (the comment adds a marker).
 */

export type BaseState =
  /** Not a pull request: there is no base to compare with. */
  | { state: "none" }
  | { state: "compared" }
  /** The model file is new in this pull request. */
  | { state: "new" }
  | { state: "unavailable"; reason: string };

export type ReportInput = {
  mode: Inputs["mode"];
  modelPath: string;
  terraformDir: string;
  cloud: Cloud;
  base: BaseState;
  diff: ModelDiff | null;
  diagram: Diagram;
  /** One line per component that needs attention (cannot be built, or flagged for review). */
  warnings: string[];
  /** Generated files whose content differs between the base model's Terraform and the head's. */
  terraformChanged: string[];
  files: FileState[];
  /** Files `write` mode changed. */
  written: string[];
  contentHash: string;
  signed: boolean;
};

const MAX_LISTED = 12;
const MAX_DIFF_CHARS = 24_000;

/**
 * Text from a model file, safe in a markdown table cell or list item. Every character that
 * markdown or HTML gives a meaning is a numeric entity, which also keeps an `@name` from
 * mentioning anyone; a bare `https://` or `www.` would still be turned into a link by GitHub,
 * so the `:` and the `.` that make one are entities too.
 */
export function markdownText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]<>()#+!|~&@]/g, (char) => `&#${char.codePointAt(0)};`)
    .replace(/:(?=\/\/)/g, "&#58;")
    .replace(/www\./gi, (match) => `${match.slice(0, 3)}&#46;`);
}

function listed<T>(items: readonly T[], render: (item: T) => string): string[] {
  const shown = items.slice(0, MAX_LISTED).map((item) => `- ${render(item)}`);
  if (items.length > MAX_LISTED) shown.push(`- and ${items.length - MAX_LISTED} more`);
  return shown;
}

type AccessKind = "added" | "removed" | "widened" | "narrowed";
type AccessRow = { rank: number; key: string; text: string; kind: AccessKind; level: EdgeAccess };

/** Where a line sits: a grant to anyone first, then unscoped, then admin, then every other widening, then narrowings, then removals. */
const RANK_PUBLIC = 0;
const RANK_NARROWED = 4;
const RANK_REMOVED = 5;
const levelRank = (access: EdgeAccess | undefined) => (access === "unscoped" ? 1 : access === "admin" ? 2 : 3);

/**
 * One line per edge whose access type was added, removed or changed, the widest first: a grant to anyone on the
 * internet, then a new or widened `unscoped` grant, then `admin`, then every other widening, then narrowings and
 * removals. Impersonating an identity (`runs-as`) is as wide as that identity: ranked at the widest access it has
 * anywhere in either version of the model, and at admin when nothing is drawn on it. The report lists only the first
 * lines and says what was cut, so what is cut is the least dangerous.
 * A grant behind a condition keeps its level and ranks as if it had none: the line says
 * "(conditional)", and a condition added or dropped is a line of its own, never a reason to omit one.
 */
function accessRows(diff: ModelDiff): AccessRow[] {
  const names = new Map<string, string>();
  const everyNode = [...diff.nodes.unchanged, ...diff.nodes.added, ...diff.nodes.removed, ...diff.nodes.changed.flatMap((c) => [c.before, c.after])];
  for (const n of everyNode) names.set(n.id, n.label);
  // A node is named by its label and by its id, which tells two nodes with the same label apart.
  const name = (id: string) => {
    const label = names.get(id);
    return label && label !== id ? `${markdownText(label)} (${markdownText(id)})` : markdownText(id);
  };
  const phrase = (access: EdgeAccess) => EDGE_ACCESS_META[access].phrase;

  // What each node can do, over both versions of the model: the widest typed edge from it, the access it has to itself, and what it can run as.
  const everyEdge = [...diff.edges.unchanged, ...diff.edges.added, ...diff.edges.removed, ...diff.edges.changed.flatMap((c) => [c.before, c.after])];
  const outgoing = new Map<string, ModelEdge[]>();
  for (const e of everyEdge) if (e.access) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
  const selfLevels = new Map<string, EdgeAccess>();
  for (const n of everyNode) if (n.selfAccess) selfLevels.set(n.id, strongerAccess(selfLevels.get(n.id), n.selfAccess));
  const widestOf = (id: string, path: ReadonlySet<string> = new Set()): EdgeAccess | undefined => {
    if (path.has(id)) return undefined;
    const next = new Set(path).add(id);
    let best = selfLevels.get(id);
    for (const e of outgoing.get(id) ?? []) {
      const level = e.access === "runs-as" ? widestOf(e.target, next) : e.access;
      if (level) best = strongerAccess(best, level);
    }
    return best;
  };
  /** What an edge gives: its own level, or for impersonation the level of the identity impersonated, admin when that is not known. */
  const levelOf = (e: { access?: EdgeAccess | undefined; target: string }): EdgeAccess => (e.access === "runs-as" ? (widestOf(e.target) ?? "admin") : (e.access ?? "runs-as"));

  const rows: AccessRow[] = [];
  const row = (source: string, target: string, rank: number, kind: AccessKind, level: EdgeAccess, text: string) =>
    rows.push({ rank, key: `${source}\u0000${target}`, text, kind, level });
  const widestRank = (e: { source: string; access?: EdgeAccess | undefined; target: string }) => (PUBLIC_PRINCIPAL_IDS.has(e.source) ? RANK_PUBLIC : levelRank(levelOf(e)));
  const when = (e: { conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined }) =>
    e.conditional ? (e.unconditional ? ` (conditional; ${e.unconditional} without the condition)` : " (conditional)") : "";
  for (const e of diff.edges.added) {
    if (e.access) row(e.source, e.target, widestRank(e), "added", levelOf(e), `**Added** ${name(e.source)} ${phrase(e.access)} ${name(e.target)}${when(e)}`);
  }
  for (const e of diff.edges.removed) {
    if (e.access) row(e.source, e.target, RANK_REMOVED, "removed", levelOf(e), `**Removed** ${name(e.source)} ${phrase(e.access)} ${name(e.target)}${when(e)}`);
  }
  for (const { before, after } of diff.edges.changed) {
    if (before.access === after.access && Boolean(before.conditional) === Boolean(after.conditional) && before.unconditional === after.unconditional) continue;
    const describe = (e: { access?: EdgeAccess | undefined; conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined }) =>
      e.access ? edgeAccessLabel({ access: e.access, conditional: e.conditional, unconditional: e.unconditional }) : "a plain connection";
    const from = describe(before);
    const to = describe(after);
    // The same type with a condition gone, or a stronger level without one, is wider; with one added it is narrower. A new type is judged by its level.
    const floor = (e: typeof before) => unconditionalLevel(e) ?? "runs-as";
    const widened =
      after.access !== undefined &&
      (before.access === after.access
        ? floor(before) !== floor(after) && strongerAccess(floor(before), floor(after)) === floor(after)
        : strongerAccess(before.access, after.access) === after.access);
    row(
      after.source,
      after.target,
      widened ? widestRank(after) : RANK_NARROWED,
      widened ? "widened" : "narrowed",
      levelOf(after),
      `**${widened ? "Widened" : "Narrowed"}** ${name(after.source)} to ${name(after.target)}: ${from} to ${to}`,
    );
  }
  // A node's access to itself is a path to widen its own access: a line like an edge's, ranked by the same level.
  const selfOf = (n: ModelNode | undefined) => (n?.selfAccess ? selfAccessPhrase(n) : undefined);
  const selfRank = (access: ModelNode["selfAccess"]) => (access === "unscoped" ? 2 : access === "admin" ? 1 : 0);
  const selfLevel = (n: ModelNode | undefined) => levelRank(n?.selfAccess);
  const own = (n: ModelNode) => n.selfAccess ?? "admin";
  for (const n of diff.nodes.added) {
    const now = selfOf(n);
    if (now) row(n.id, n.id, selfLevel(n), "added", own(n), `**Added** ${name(n.id)} ${now}`);
  }
  for (const n of diff.nodes.removed) {
    const was = selfOf(n);
    if (was) row(n.id, n.id, RANK_REMOVED, "removed", own(n), `**Removed** ${name(n.id)} ${was}`);
  }
  for (const { before, after } of diff.nodes.changed) {
    const was = selfOf(before);
    const now = selfOf(after);
    if (was === now) continue;
    if (now && !was) row(after.id, after.id, selfLevel(after), "added", own(after), `**Added** ${name(after.id)} ${now}`);
    else if (was && !now) row(after.id, after.id, RANK_REMOVED, "removed", own(before), `**Removed** ${name(after.id)} ${was}`);
    else {
      // Wider when the level or what holds without a condition went up (even if the other went down: fail closed); narrower otherwise.
      const floor = (n: ModelNode) => (n.selfConditional ? (n.selfUnconditional === undefined ? 0 : selfRank(n.selfUnconditional)) : selfRank(n.selfAccess));
      const widened = selfRank(after.selfAccess) > selfRank(before.selfAccess) || floor(after) > floor(before);
      row(after.id, after.id, widened ? selfLevel(after) : RANK_NARROWED, widened ? "widened" : "narrowed", own(after), `**${widened ? "Widened" : "Narrowed"}** ${name(after.id)}: ${was} to ${now}`);
    }
  }
  rows.sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

/** The access lines, the first `MAX_LISTED` of them, and a last line that says how many were cut, of which kinds, and the widest of them. */
function accessLines(diff: ModelDiff): string[] {
  const rows = accessRows(diff);
  const shown = rows.slice(0, MAX_LISTED).map((r) => `- ${r.text}`);
  const cut = rows.slice(MAX_LISTED);
  if (cut.length > 0) {
    const kinds = (["added", "widened", "narrowed", "removed"] as const)
      .map((kind) => [kind, cut.filter((r) => r.kind === kind).length] as const)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${count} ${kind}`);
    const widest = cut.map((r) => r.level).reduce<EdgeAccess | undefined>((best, level) => strongerAccess(best, level), undefined);
    shown.push(`- and ${cut.length} more not shown: ${kinds.join(", ")}${widest ? ` (widest: ${widest})` : ""}`);
  }
  return shown;
}

/** A node whose only change is its access to itself: said in those words, not as a change of kind. "may" when the access is conditional or could not be read closely. */
function selfOnlyLine(before: ModelNode, after: ModelNode): string {
  const id = markdownText(before.id);
  const was = selfAccessLabel(before);
  const now = selfAccessLabel(after);
  const may = after.selfConditional || after.selfAccess === "unscoped" ? "may" : "can";
  if (now === undefined) return `${id} no longer ${before.selfConditional || before.selfAccess === "unscoped" ? "may" : "can"} widen its own access (was ${was ?? "none"})`;
  return was === undefined ? `${id} ${may} now widen its own access: ${now}` : `${id} ${may} widen its own access: ${was} to ${now}`;
}

function statusLine(input: ReportInput): string {
  const dir = `\`${input.terraformDir}\``;
  const drifted = input.files.filter((f) => f.status !== "same").length;
  if (input.mode === "write") {
    return input.written.length > 0
      ? `Regenerated ${dir}: ${input.written.length} ${input.written.length === 1 ? "file" : "files"} written.`
      : `${dir} already matches the model: nothing written.`;
  }
  return drifted === 0
    ? `${dir} matches \`${input.modelPath}\`.`
    : `${dir} differs from \`${input.modelPath}\` in ${drifted} ${drifted === 1 ? "file" : "files"}. Regenerate it and commit the result.`;
}

function modelSection(input: ReportInput): string[] {
  const { base, diff, diagram } = input;
  if (base.state === "none") return [];
  const out = ["### Model changes", ""];
  if (base.state === "unavailable") {
    out.push(`The model could not be compared with the base: ${markdownText(base.reason)}.`, "");
    return out;
  }
  if (base.state === "new") out.push(`\`${input.modelPath}\` is new in this pull request, so every component is added.`, "");
  if (!diff || !hasModelChanges(diff)) {
    out.push("The model is unchanged.", "");
    return out;
  }
  if (diagram.mermaid) {
    out.push("```mermaid", diagram.mermaid, "```", "");
    out.push(
      diagram.scope === "changes"
        ? "The model is too large to draw whole, so only what changed and the components beside it are shown."
        : "",
      "Green: added. Red, dashed: removed. Amber: changed.",
      "",
    );
  } else if (diagram.scope === "omitted") {
    out.push("The diagram is too large to draw; the table below has the counts.", "");
  }
  const nodes = diff.nodes;
  const edges = diff.edges;
  out.push(
    "| | Added | Removed | Changed |",
    "| --- | ---: | ---: | ---: |",
    `| Nodes | ${nodes.added.length} | ${nodes.removed.length} | ${nodes.changed.length} |`,
    `| Edges | ${edges.added.length} | ${edges.removed.length} | ${edges.changed.length} |`,
    "",
  );
  if (nodes.changed.length > 0) {
    out.push(
      ...listed(nodes.changed, ({ before, after }) => {
        if (onlySelfAccessChanged(before, after)) return selfOnlyLine(before, after);
        const what =
          before.label !== after.label
            ? `"${markdownText(before.label)}" to "${markdownText(after.label)}"`
            : `${markdownText(before.kind)} to ${markdownText(after.kind)}`;
        return `${markdownText(before.id)} changed: ${what}`;
      }),
      "",
    );
  }
  const access = accessLines(diff);
  if (access.length > 0) {
    out.push("#### Access changes", "", ...access, "");
  }
  return out;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = ["## Diagram", "", statusLine(input), ""];
  lines.push(...modelSection(input));

  const hasBase = input.base.state === "compared" || input.base.state === "new";
  lines.push("### Summary", "", "| | |", "| --- | --- |");
  lines.push(`| Cloud | ${input.cloud} |`);
  lines.push(`| Feasibility warnings | ${input.warnings.length} |`);
  if (hasBase) {
    lines.push(`| Terraform files changed by this model change | ${input.terraformChanged.length} |`);
  }
  const drifted = input.files.filter((f) => f.status !== "same");
  lines.push(`| Terraform files differing from \`${input.terraformDir}\` | ${drifted.length} |`);
  lines.push(`| Receipt | \`${input.contentHash}\` (${input.signed ? "signed" : "unsigned"}) |`, "");

  if (input.warnings.length > 0) {
    lines.push("<details><summary>Feasibility warnings</summary>", "", ...listed(input.warnings, markdownText), "", "</details>", "");
  }
  if (hasBase && input.terraformChanged.length > 0) {
    lines.push(
      "<details><summary>Terraform files changed by this model change</summary>",
      "",
      ...listed(input.terraformChanged, (name) => `\`${markdownText(name)}\``),
      "",
      "</details>",
      "",
    );
  }
  if (drifted.length > 0 && input.mode === "check") {
    let budget = MAX_DIFF_CHARS;
    const diffs: string[] = [];
    for (const file of drifted) {
      const text = file.diff.length > budget ? `${file.diff.slice(0, Math.max(0, budget))}\n(diff cut short)\n` : file.diff;
      budget -= text.length;
      // A diff line can hold a backtick run, so the fence is longer than any in the text.
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      diffs.push(`${fence}diff\n${text}${fence}`);
      if (budget <= 0) break;
    }
    lines.push("<details><summary>Difference from the committed Terraform</summary>", "", ...diffs, "", "</details>", "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function commentBody(report: string): string {
  return `${COMMENT_MARKER}\n${report}`;
}
