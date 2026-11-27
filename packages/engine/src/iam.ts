// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { attributeOf, extractReferences, type HclBlock, stringValue } from "./hcl.ts";
import type { Cloud, EdgeAccess } from "./model.ts";

/**
 * The access a Terraform file grants, read as text. A role's policy is read the way the
 * rest of the parser reads Terraform: nothing is evaluated, no function runs and no value
 * is interpolated. A `jsonencode({...})`, a heredoc of JSON, a `aws_iam_policy_document`
 * data source and an Azure role assignment are all literal text in the file, and the only
 * things taken from them are the names of the resources they point at and a coarse level
 * (read, write, admin) from the action names. Policy text itself is never kept: the result
 * is edges, and an edge carries a level and nothing else.
 *
 * What the text cannot bound is typed `unscoped` rather than guessed at: a wildcard
 * resource, a policy that is a variable, a file or a template, an action that is not a
 * plain string, a role assigned over a subscription.
 */

/** The conceptual node an `unscoped` edge ends at. */
export const ANY_RESOURCE_ID = "any-resource";

type IamEdge = {
  /** The node holding the grant: the role, identity or app. */
  source: string;
  /** The resource it reaches, or `ANY_RESOURCE_ID`. */
  target: string;
  access: EdgeAccess;
  /** Every statement behind the grant carries a Condition. The level is the same; the condition may narrow when it applies. */
  conditional?: true;
};

export type IamReading = {
  edges: IamEdge[];
  /** Blocks whose meaning is now drawn as an edge, so they are not "untranslated". */
  consumed: Set<HclBlock>;
};

const RANK: Record<EdgeAccess, number> = { "runs-as": 0, read: 1, write: 2, admin: 3, unscoped: 4 };

/** The stronger of two access types: a pair of nodes gets one edge, typed by the most it can do. */
export function strongerAccess(a: EdgeAccess | undefined, b: EdgeAccess): EdgeAccess {
  return a !== undefined && RANK[a] >= RANK[b] ? a : b;
}

type Typed = { access?: EdgeAccess | undefined; conditional?: boolean | undefined };

/**
 * Two grants over one pair of nodes: the type is the stronger one, and the edge is
 * conditional only when every grant at that strongest level is. A condition never lowers a
 * level, and a grant without one is never hidden behind a conditional one.
 */
export function mergeAccess(a: Typed | undefined, b: { access: EdgeAccess; conditional?: boolean | undefined }): { access: EdgeAccess; conditional?: true } {
  const access = strongerAccess(a?.access, b.access);
  const holds = (t: Typed | undefined) => t?.access === access;
  const conditional = [a, b].filter(holds).every((t) => t?.conditional === true);
  return conditional ? { access, conditional: true } : { access };
}

/* ------------------------------------------------------------ value reader -- */

/** A literal Terraform value, as far as this reader needs one. */
type Val =
  | { t: "obj"; entries: Array<{ key: string; value: Val }> }
  | { t: "list"; items: Val[] }
  | { t: "str"; text: string; interpolated: boolean; refs: string[] }
  | { t: "expr"; text: string; refs: string[] };

class Unreadable extends Error {}

/** How deep strings, braces and JSON may nest before the reader gives up (and the grant becomes unscoped). */
const MAX_DEPTH = 64;

function skipString(s: string, start: number, depth = 0): number {
  if (depth > MAX_DEPTH) throw new Unreadable();
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else if (c === "$" && s[i + 1] === "{") i = skipBraces(s, i + 1, depth + 1);
    else i++;
  }
  throw new Unreadable();
}

function skipBraces(s: string, start: number, nesting = 0): number {
  if (nesting > MAX_DEPTH) throw new Unreadable();
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      i = skipString(s, i, nesting + 1);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
    i++;
  }
  throw new Unreadable();
}

/** Skip spaces, commas and comments. */
function skipTrivia(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const c = s[i] ?? "";
    if (/[\s,]/.test(c)) i++;
    else if (c === "#" || (c === "/" && s[i + 1] === "/")) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
    } else break;
  }
  return i;
}

function readExpression(s: string, start: number): [Val, number] {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i] ?? "";
    if (c === '"') {
      i = skipString(s, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === "," || c === "\n")) break;
    i++;
  }
  const text = s.slice(start, i).trim();
  if (text === "") throw new Unreadable();
  return [{ t: "expr", text, refs: extractReferences(text) }, i];
}

const KEY_RE = /[A-Za-z0-9_.-]+/y;

function readValue(s: string, from: number, depth: number): [Val, number] {
  if (depth > MAX_DEPTH) throw new Unreadable();
  const i = skipTrivia(s, from);
  const c = s[i];
  if (c === "{") {
    const entries: Array<{ key: string; value: Val }> = [];
    let j = i + 1;
    for (;;) {
      j = skipTrivia(s, j);
      if (j >= s.length) throw new Unreadable();
      if (s[j] === "}") return [{ t: "obj", entries }, j + 1];
      let key: string;
      if (s[j] === '"') {
        const end = skipString(s, j);
        key = s.slice(j + 1, end - 1);
        j = end;
      } else {
        KEY_RE.lastIndex = j;
        const m = KEY_RE.exec(s);
        if (!m) throw new Unreadable();
        key = m[0];
        j += key.length;
      }
      j = skipTrivia(s, j);
      if (s[j] !== "=" && s[j] !== ":") throw new Unreadable();
      const [value, next] = readValue(s, j + 1, depth + 1);
      entries.push({ key, value });
      j = next;
    }
  }
  if (c === "[") {
    const elements: Val[] = [];
    let j = i + 1;
    for (;;) {
      j = skipTrivia(s, j);
      if (j >= s.length) throw new Unreadable();
      if (s[j] === "]") return [{ t: "list", items: elements }, j + 1];
      const [value, next] = readValue(s, j, depth + 1);
      elements.push(value);
      j = next;
    }
  }
  if (c === '"') {
    const end = skipString(s, i);
    const quoted = s.slice(i, end);
    const text = quoted.slice(1, -1);
    return [{ t: "str", text, interpolated: text.includes("${"), refs: extractReferences(quoted) }, end];
  }
  return readExpression(s, i);
}

function readVal(text: string): Val | null {
  try {
    const [value, end] = readValue(text, 0, 0);
    // Anything after the value (an operator, a second expression) means it was not read in full.
    return skipTrivia(text, end) === text.length ? value : null;
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

/** The balanced text after `name(` in an expression, or null. */
function callArgument(expr: string, name: string): string | null {
  const open = expr.indexOf(`${name}(`);
  if (open === -1) return null;
  let depth = 0;
  let i = open + name.length;
  const begin = i + 1;
  try {
    while (i < expr.length) {
      const c = expr[i] ?? "";
      if (c === '"') {
        i = skipString(expr, i);
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return expr.slice(i + 1).trim() === "" ? expr.slice(begin, i) : null;
      i++;
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
  }
  return null;
}

/** JSON text with `${...}` references kept, as a `Val`. */
function jsonToVal(text: string): Val | null {
  const holes: string[] = [];
  let masked = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "{") {
      try {
        const end = skipBraces(text, i + 1);
        holes.push(text.slice(i, end));
        masked += `\uE000${holes.length - 1}\uE001`;
        i = end - 1;
        continue;
      } catch (error) {
        if (error instanceof Unreadable) return null;
        throw error;
      }
    }
    masked += text[i] ?? "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(masked);
  } catch {
    return null;
  }
  const convert = (v: unknown, depth: number): Val | null => {
    if (depth > MAX_DEPTH) return null;
    if (typeof v === "string") {
      const restored = v.replace(/\uE000(\d+)\uE001/g, (_, n: string) => holes[Number(n)] ?? "");
      return { t: "str", text: restored, interpolated: holes.length > 0 && restored.includes("${"), refs: extractReferences(JSON.stringify(restored)) };
    }
    if (Array.isArray(v)) {
      const converted = v.map((item) => convert(item, depth + 1));
      return converted.every((x) => x !== null) ? { t: "list", items: converted as Val[] } : null;
    }
    if (v !== null && typeof v === "object") {
      const entries: Array<{ key: string; value: Val }> = [];
      for (const [key, inner] of Object.entries(v)) {
        const value = convert(inner, depth + 1);
        if (!value) return null;
        entries.push({ key, value });
      }
      return { t: "obj", entries };
    }
    return { t: "expr", text: String(v), refs: [] };
  };
  return convert(parsed, 0);
}

/** The text of a heredoc expression, or null when the expression is not one. */
function heredocBody(expr: string): string | null {
  const text = expr.trim();
  // The header is the first line: cut it with indexOf so no pattern runs over the rest.
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return null;
  const tag = /^<<-?[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(0, firstNewline))?.[1];
  if (!tag) return null;
  const bodyStart = firstNewline + 1;
  // One pass over the lines: the first line that is only the tag ends the body, and nothing but space may follow it.
  let lineStart = bodyStart;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (text.slice(lineStart, lineEnd).trim() === tag) {
      if (text.slice(lineEnd).trim() !== "") return null;
      return text.slice(bodyStart, Math.max(bodyStart, lineStart - 1));
    }
    if (newline === -1) return null;
    lineStart = newline + 1;
  }
  return null;
}

/* ---------------------------------------------------------------- policies -- */

type Statement = {
  actions: Val[];
  notActions: boolean;
  resources: Val[];
  notResources: boolean;
  /** The statement has a Condition: some request it allows may be refused. */
  conditional: boolean;
};

const norm = (key: string) => key.toLowerCase().replace(/_/g, "");

/** A value that could not be read: it never matches a pattern, so it ends up unscoped. */
const UNREADABLE: Val = { t: "expr", text: "", refs: [] };

function listOf(v: Val | undefined): Val[] {
  if (!v) return [];
  return v.t === "list" ? v.items : [v];
}

/** Every entry whose key is one of `names`: a repeated key is read as all of its values, never just the first. */
function valuesOf(obj: Val, ...names: string[]): Val[] {
  if (obj.t !== "obj") return [];
  return obj.entries.filter((e) => names.includes(norm(e.key))).map((e) => e.value);
}

/** Only a statement whose every Effect is a plain "Deny" is skipped. */
function isDeny(effects: Val[]): boolean {
  return effects.length > 0 && effects.every((e) => e.t === "str" && e.text.toLowerCase() === "deny");
}

/** The Allow statements of a policy document value, or null when it cannot be read. */
function statementsOfDocument(doc: Val): Statement[] | null {
  const lists = valuesOf(doc, "statement");
  if (lists.length === 0) return null;
  const out: Statement[] = [];
  for (const st of lists.flatMap(listOf)) {
    if (st.t !== "obj") return null;
    if (isDeny(valuesOf(st, "effect"))) continue;
    out.push(statementOf(st));
  }
  return out;
}

/**
 * Whether a Condition value is a real one: an object with at least one operator, each
 * holding at least one key. An empty object, a string or anything unreadable is not
 * counted, so a statement is only ever marked conditional on evidence.
 */
function isCondition(v: Val): boolean {
  return (
    v.t === "obj" &&
    v.entries.length > 0 &&
    v.entries.every((operator) => operator.value.t === "obj" && operator.value.entries.length > 0)
  );
}

function statementOf(st: Val, conditionBlock = false): Statement {
  const conditional = conditionBlock || valuesOf(st, "condition", "conditions").some(isCondition);
  const actions = valuesOf(st, "action", "actions");
  const notActions = valuesOf(st, "notaction", "notactions");
  const resources = valuesOf(st, "resource", "resources");
  const notResources = valuesOf(st, "notresource", "notresources");
  // A statement with no Action or no Resource key is not "grants nothing": it is unknown.
  return {
    actions: actions.length + notActions.length > 0 ? [...actions, ...notActions].flatMap(listOf) : [UNREADABLE],
    notActions: notActions.length > 0,
    resources: resources.length + notResources.length > 0 ? [...resources, ...notResources].flatMap(listOf) : [UNREADABLE],
    notResources: notResources.length > 0,
    conditional,
  };
}

/** The statements of a `data "aws_iam_policy_document"`, or null when it merges or generates others. */
function statementsOfDataBlock(doc: HclBlock): Statement[] | null {
  if (
    attributeOf(doc, "source_policy_documents") !== undefined ||
    attributeOf(doc, "override_policy_documents") !== undefined ||
    doc.blocks.some((b) => b.type === "dynamic")
  ) {
    return null;
  }
  const out: Statement[] = [];
  for (const b of doc.blocks) {
    if (b.type !== "statement") continue;
    // An attribute that cannot be read is kept as unreadable, not dropped: a dropped one reads as "grants nothing".
    const obj: Val = { t: "obj", entries: b.attributes.map((a) => ({ key: a.key, value: readVal(a.value) ?? UNREADABLE })) };
    if (isDeny(valuesOf(obj, "effect"))) continue;
    out.push(statementOf(obj, b.blocks.some(isConditionBlock)));
  }
  return out;
}

/** A static `condition { test, variable, values }` block; a `dynamic` one is not counted. */
function isConditionBlock(b: HclBlock): boolean {
  return b.type === "condition" && ["test", "variable", "values"].every((key) => attributeOf(b, key) !== undefined);
}

const READ_VERBS = ["get", "list", "describe", "head", "batchget", "query", "scan", "select", "lookup", "view", "search", "read", "receive", "decrypt", "verify"];
const PERMISSION_NAME = /(policy|acl|grant|permission|passrole|assumerole)/;
const ACTION_CHARS = /^[A-Za-z0-9*:-]+$/;

const startsWithReadVerb = (name: string) => READ_VERBS.some((verb) => name.startsWith(verb));

/**
 * The level one action grants, from its name alone. Null when the action is not a plain
 * string this reader can be sure of. IAM matches action names without regard to case, and a
 * wildcard stands for names that cannot be seen, so only a wildcard that begins with a read
 * verb (`Get*`, `List*`) is read; every other wildcard may include a permission change.
 */
function actionLevel(action: Val): "read" | "write" | "admin" | null {
  if (action.t !== "str" || !ACTION_CHARS.test(action.text)) return null;
  const text = action.text.toLowerCase();
  if (text === "*") return "admin";
  const parts = text.split(":");
  const [service = "", name = ""] = parts;
  if (parts.length !== 2 || service === "" || name === "") return null;
  if (text.includes("*")) {
    const star = name.indexOf("*");
    return startsWithReadVerb(star === -1 ? name : name.slice(0, star)) ? "read" : "admin";
  }
  const reads = startsWithReadVerb(name);
  if (service === "iam" || service === "organizations") return reads ? "read" : "admin";
  if (reads) return "read";
  return PERMISSION_NAME.test(name) ? "admin" : "write";
}

/* ------------------------------------------------------------- references -- */

/** An address with attributes after it: `aws_s3_bucket.data.arn`, `module.api.arn`, `aws_s3_bucket.data[0].arn`. */
const SIMPLE_REFERENCE = /^([a-z][a-z0-9_]*)\.([A-Za-z_][\w-]*)(?:\[(?:\d+|each\.key|count\.index)\])?(?:\.[A-Za-z_][\w-]*)+$/;

type Resolved = { kind: "node"; id: string } | { kind: "outside" } | { kind: "unknown" };

/**
 * What one reference expression points at: a drawn node, a resource the picture leaves out
 * (a grant to a thing that is not drawn adds nothing), or something this reader cannot pin
 * down (a variable, a local, a module output, a function call), which has to be unscoped.
 */
function resolveReference(text: string, owner: (address: string) => string | undefined): Resolved {
  const m = SIMPLE_REFERENCE.exec(text.trim());
  const head = m?.[1];
  const name = m?.[2];
  if (!head || !name) return { kind: "unknown" };
  if (head === "data") return { kind: "outside" };
  const id = owner(`${head}.${name}`);
  if (id) return { kind: "node", id };
  return head === "module" || NOT_A_RESOURCE.has(head) ? { kind: "unknown" } : { kind: "outside" };
}

const NOT_A_RESOURCE = new Set(["var", "local", "each", "count", "path", "terraform", "self"]);

/** `` stands for a template that resolved to a drawn node. */
const HOLE = "";

/**
 * Reads a string resource. Every `${...}` has to be one reference to a drawn node; a
 * wildcard may only follow one, as the path under it (`${bucket.arn}/*`). Anything else
 * that contains `*` or `?`, an escape or a `%{` directive could name more than it shows.
 * Returns true when the string reaches beyond what can be drawn.
 */
function stringReach(text: string, owner: (address: string) => string | undefined, add: (id: string) => void): boolean {
  if (/[\\]|%\{|\$\$/.test(text)) return true;
  let masked = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "$" && text[i + 1] === "{") {
      let end: number;
      try {
        end = skipBraces(text, i + 1);
      } catch {
        return true;
      }
      const target = resolveReference(text.slice(i + 2, end - 1), owner);
      if (target.kind !== "node") return true;
      add(target.id);
      masked += HOLE;
      i = end;
      continue;
    }
    masked += text[i] ?? "";
    i++;
  }
  const wildcard = masked.search(/[*?]/);
  if (wildcard === -1) return false;
  const path = masked.search(new RegExp(`${HOLE}[/:]`));
  return path === -1 || wildcard < path + 2;
}

type Reach = { targets: string[]; broad: boolean };

/** Which drawn resources a Resource value points at, and whether it also reaches beyond them. */
function reachOf(values: Val[], owner: (address: string) => string | undefined): Reach {
  const reach: Reach = { targets: [], broad: false };
  const add = (id: string | undefined) => {
    if (id && !reach.targets.includes(id)) reach.targets.push(id);
  };
  for (const v of values) {
    if (v.t === "list") {
      const inner = reachOf(v.items, owner);
      for (const t of inner.targets) add(t);
      reach.broad ||= inner.broad;
    } else if (v.t === "obj") {
      reach.broad = true;
    } else if (v.t === "str") {
      if (stringReach(v.text, owner, add)) reach.broad = true;
    } else {
      const target = resolveReference(v.text, owner);
      if (target.kind === "node") add(target.id);
      else if (target.kind === "unknown") {
        reach.broad = true;
        for (const ref of v.refs) add(owner(ref));
      }
    }
  }
  return reach;
}

function levelOf(actions: Val[], notActions: boolean): EdgeAccess {
  if (notActions || actions.length === 0) return "unscoped";
  let level: EdgeAccess = "read";
  for (const a of actions) {
    const l = actionLevel(a) ?? "unscoped";
    level = strongerAccess(level, l);
  }
  return level;
}

function edgesOfStatements(
  source: string,
  statements: Statement[] | null,
  owner: (address: string) => string | undefined,
): IamEdge[] {
  if (statements === null) return [{ source, target: ANY_RESOURCE_ID, access: "unscoped" }];
  const out: IamEdge[] = [];
  for (const st of statements) {
    if (st.actions.length === 0 || st.resources.length === 0) continue;
    const reach = st.notResources ? { targets: [], broad: true } : reachOf(st.resources, owner);
    const level = levelOf(st.actions, st.notActions);
    const conditional = st.conditional ? ({ conditional: true } as const) : {};
    for (const target of reach.targets) if (target !== source) out.push({ source, target, access: level, ...conditional });
    if (reach.broad) out.push({ source, target: ANY_RESOURCE_ID, access: "unscoped", ...conditional });
  }
  return out;
}

/* -------------------------------------------------------------------- AWS -- */

function readAws(blocks: HclBlock[], owner: (address: string) => string | undefined, out: IamReading): void {
  const policies = new Map<string, HclBlock>();
  const documents = new Map<string, HclBlock>();
  for (const b of blocks) {
    if (b.type === "resource" && b.labels[0] === "aws_iam_policy") policies.set(`aws_iam_policy.${b.labels[1]}`, b);
    if (b.type === "data" && b.labels[0] === "aws_iam_policy_document") documents.set(`${b.labels[0]}.${b.labels[1]}`, b);
  }

  const principalsOf = (expr: string | undefined): string[] => {
    const found: string[] = [];
    for (const address of expr ? extractReferences(expr) : []) {
      const id = owner(address);
      if (id && !found.includes(id)) found.push(id);
    }
    return found;
  };

  /** The statements of a policy expression, and the document blocks they came from; null when it is not text this reader can see. */
  const statementsOf = (expr: string | undefined, via: HclBlock[]): Statement[] | null => {
    const text = expr?.trim();
    if (!text) return null;
    const ref = /^data\.(aws_iam_policy_document)\.([A-Za-z_][\w-]*)\.json$/.exec(text);
    if (ref) {
      const doc = documents.get(`${ref[1]}.${ref[2]}`);
      if (!doc) return null;
      via.push(doc);
      return statementsOfDataBlock(doc);
    }
    let json: Val | null = null;
    const encoded = callArgument(text, "jsonencode");
    if (text.startsWith("jsonencode(") && encoded !== null) json = readVal(encoded);
    else if (text.startsWith("<<")) {
      const body = heredocBody(text);
      json = body === null ? null : jsonToVal(body);
    } else if (text.startsWith('"')) {
      try {
        const inner: unknown = JSON.parse(text);
        json = typeof inner === "string" ? jsonToVal(inner) : null;
      } catch {
        json = null;
      }
    }
    return json ? statementsOfDocument(json) : null;
  };

  /** Fails closed: a policy that cannot be read, or that makes the reader throw, is an unscoped grant. */
  const guarded = (source: string, read: () => IamEdge[]): IamEdge[] => {
    try {
      return read();
    } catch {
      return [{ source, target: ANY_RESOURCE_ID, access: "unscoped" }];
    }
  };

  /** The grant of one policy expression. `holders` are the blocks that are consumed once it has drawn an edge. */
  const grant = (source: string, expr: string | undefined, holders: HclBlock[]): number => {
    const via: HclBlock[] = [];
    const edges = guarded(source, () => edgesOfStatements(source, statementsOf(expr, via), owner));
    out.edges.push(...edges);
    if (edges.length > 0) for (const b of [...holders, ...via]) out.consumed.add(b);
    return edges.length;
  };

  /**
   * A managed policy attached to `source`. Only a policy defined in this file is read; an
   * ARN, a data source, a variable or anything else is a policy this reader cannot see
   * (AdministratorAccess, PowerUserAccess, IAMFullAccess and the rest), so it is unscoped.
   */
  const attach = (source: string, expr: string | undefined, holder: HclBlock | null): void => {
    const unscoped = () => {
      out.edges.push({ source, target: ANY_RESOURCE_ID, access: "unscoped" });
      if (holder) out.consumed.add(holder);
    };
    if (expr === undefined) {
      if (holder) unscoped();
      return;
    }
    let items: Val[];
    try {
      const read = readVal(expr);
      items = read === null ? [UNREADABLE] : listOf(read);
    } catch {
      items = [UNREADABLE];
    }
    for (const item of items) {
      const policy = item.t === "list" || item.t === "obj" ? undefined : policies.get(policyAddress(item));
      if (!policy) {
        unscoped();
        continue;
      }
      grant(source, attributeOf(policy, "policy"), [policy, ...(holder ? [holder] : [])]);
    }
  };

  for (const b of blocks) {
    if (b.type !== "resource") continue;
    const [type, name] = b.labels;
    if (type === "aws_iam_role_policy") {
      for (const source of principalsOf(attributeOf(b, "role"))) grant(source, attributeOf(b, "policy"), [b]);
    } else if (type === "aws_iam_role_policy_attachment" || type === "aws_iam_policy_attachment") {
      for (const source of principalsOf(attributeOf(b, type === "aws_iam_policy_attachment" ? "roles" : "role"))) {
        attach(source, attributeOf(b, "policy_arn"), b);
      }
    } else if (type === "aws_iam_role" && name) {
      const source = owner(`aws_iam_role.${name}`);
      if (!source) continue;
      for (const inline of b.blocks) if (inline.type === "inline_policy") grant(source, attributeOf(inline, "policy"), []);
      attach(source, attributeOf(b, "managed_policy_arns"), null);
    } else if (type === "aws_iam_instance_profile" && principalsOf(attributeOf(b, "role")).length > 0) {
      out.consumed.add(b);
    }
  }
}

/** The address of the local policy an ARN expression names (`aws_iam_policy.x.arn` or its template), or "" for anything else. */
function policyAddress(item: Val): string {
  if (item.t === "list" || item.t === "obj") return "";
  let text = item.text;
  if (item.t === "str") {
    const template = /^\$\{([^{}"]*)\}$/.exec(text);
    if (!template) return "";
    text = template[1] ?? "";
  }
  const m = /^(aws_iam_policy)\.([A-Za-z_][\w-]*)(?:\[(?:\d+|each\.key|count\.index)\])?\.(?:arn|id)$/.exec(text.trim());
  return m ? `${m[1]}.${m[2]}` : "";
}

/* ------------------------------------------------------------------ Azure -- */

/** The level a built-in Azure role grants, from its name. Null for a role that is not recognised. */
function azureRoleLevel(name: string): "read" | "write" | "admin" | null {
  const role = name.trim();
  if (/[\\$%]/.test(role)) return null;
  if (/^(owner|user access administrator|role based access control administrator)$/i.test(role)) return "admin";
  if (/(\badministrator\b|\bdata owner\b|\bowner\b)/i.test(role)) return "admin";
  if (/(reader|viewer|receiver|secrets user)$/i.test(role)) return "read";
  if (/(contributor|officer|sender|operator|writer|crypto user)$/i.test(role)) return "write";
  return null;
}

/** Scopes that cover more than one resource, whatever they are called. */
const WIDE_SCOPE_TYPES = new Set(["azurerm_resource_group", "azurerm_subscription", "azurerm_management_group"]);

const AZURE_RESOURCE_ID = /^(azurerm_[a-z0-9_]+)\.([A-Za-z_][\w-]*)(?:\[(?:\d+|each\.key|count\.index)\])?\.id$/;

/**
 * The drawn node a role assignment's scope is exactly: the `.id` of one resource (or that id
 * with a literal sub-path under it). A subscription, a resource group, a module output, a
 * literal id, a variable or anything computed is not one drawn resource, so it is undefined.
 */
function azureScopeTarget(scope: string, owner: (address: string) => string | undefined): string | undefined {
  let text = scope.trim();
  let tail = "";
  if (text.startsWith('"')) {
    const inner = stringValue(text) ?? "";
    const m = /^\$\{([^{}"]*)\}((?:\/[A-Za-z0-9._-]+)*)$/.exec(inner);
    if (!m || (m[2] ?? "").split("/").includes("..")) return undefined;
    text = m[1] ?? "";
    tail = m[2] ?? "";
  }
  const m = AZURE_RESOURCE_ID.exec(text.trim());
  const type = m?.[1];
  if (!m || !type || WIDE_SCOPE_TYPES.has(type) || tail.includes("//")) return undefined;
  return owner(`${type}.${m[2]}`);
}

function readAzure(blocks: HclBlock[], owner: (address: string) => string | undefined, out: IamReading): void {
  for (const b of blocks) {
    if (b.type !== "resource" || b.labels[0] !== "azurerm_role_assignment") continue;
    let source: string | undefined;
    for (const address of extractReferences(attributeOf(b, "principal_id") ?? "")) {
      source = owner(address);
      if (source) break;
    }
    if (!source) continue;

    const unscoped: IamEdge = { source, target: ANY_RESOURCE_ID, access: "unscoped" };
    let edge: IamEdge | null;
    try {
      const roleName = stringValue(attributeOf(b, "role_definition_name"));
      const level: EdgeAccess = (roleName === undefined ? null : azureRoleLevel(roleName)) ?? "unscoped";
      const target = azureScopeTarget(attributeOf(b, "scope") ?? "", owner);
      edge = target === undefined ? unscoped : target === source ? null : { source, target, access: level };
    } catch {
      edge = unscoped;
    }
    if (edge) {
      out.edges.push(edge);
      out.consumed.add(b);
    }
  }
}

/* ------------------------------------------------------------------- read -- */

/**
 * Every grant the file makes to a drawn node, as edges. `owner` maps a Terraform address
 * (`aws_s3_bucket.data`, `module.api`) to the id of the node that block belongs to.
 */
export function readIam(blocks: HclBlock[], owner: (address: string) => string | undefined, cloud: Cloud): IamReading {
  const reading: IamReading = { edges: [], consumed: new Set() };
  if (cloud === "aws") readAws(blocks, owner, reading);
  else readAzure(blocks, owner, reading);

  // One edge per pair, typed by the strongest grant.
  const merged = new Map<string, IamEdge>();
  for (const edge of reading.edges) {
    const key = `${edge.source}->${edge.target}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { source: edge.source, target: edge.target, ...mergeAccess(existing, edge) } : edge);
  }
  reading.edges = [...merged.values()];
  return reading;
}

const RUNS_AS_KEYS = new Set([
  "role",
  "iam_role",
  "execution_role_arn",
  "task_role_arn",
  "iam_instance_profile",
  "identity_ids",
  "user_assigned_identity_id",
  "user_assigned_identity_ids",
]);

/**
 * The addresses of the roles and managed identities a workload runs under: what its
 * `role`, `task_role_arn`, `iam_instance_profile` (followed to the profile's role) or
 * `identity_ids` point at.
 */
export function runsAsAddresses(workload: HclBlock[], all: HclBlock[]): string[] {
  const profiles = new Map<string, string[]>();
  for (const b of all) {
    if (b.type === "resource" && b.labels[0] === "aws_iam_instance_profile") {
      profiles.set(`aws_iam_instance_profile.${b.labels[1]}`, extractReferences(attributeOf(b, "role") ?? ""));
    }
  }
  const found: string[] = [];
  const visit = (block: HclBlock) => {
    for (const a of block.attributes) {
      if (!RUNS_AS_KEYS.has(a.key)) continue;
      for (const address of extractReferences(a.value)) {
        for (const resolved of profiles.get(address) ?? [address]) if (!found.includes(resolved)) found.push(resolved);
      }
    }
    for (const nested of block.blocks) visit(nested);
  };
  for (const b of workload) visit(b);
  return found;
}
