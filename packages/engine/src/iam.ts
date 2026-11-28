// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { MANAGED_WITHOUT_IAM_WRITE, MAX_MANAGED_EDGES, MAX_MANAGED_TARGETS, managedPolicyGrants, SERVICE_RESOURCE_TYPES } from "./aws-managed-policies.ts";
import { attributeOf, extractReferences, type HclBlock, stringValue } from "./hcl.ts";
import type { EdgeAccess } from "./model.ts";

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
 * plain string, a role assigned over a subscription, a managed policy that is neither
 * defined in the file nor in the bundled table of well-known AWS ones.
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
  /** With `conditional`: the strongest level some grant over the same pair gives with no condition at all. Always below `access`. */
  unconditional?: EdgeAccess;
};

export type IamReading = {
  edges: IamEdge[];
  /** Blocks whose meaning is now drawn as an edge, so they are not "untranslated". */
  consumed: Set<HclBlock>;
  /** The stand-ins for principals the picture does not draw that an edge starts at, by node id (see `GCP_PRINCIPALS`). The reader adds a node for each. */
  principals: Map<string, string>;
  /**
   * The nodes whose own grants reach the node itself at `admin` or `unscoped`: a role whose policy may rewrite
   * the role (`iam:PutRolePolicy` on its own ARN), a service account that may mint tokens for itself. Such a
   * grant cannot be an edge (nothing here draws a node to itself), but it is an escalation path, so it is carried as
   * its own entry, one per node, `conditional` as an edge would be. Lower levels on oneself are not escalation and are not listed.
   */
  self: IamEdge[];
};

const RANK: Record<EdgeAccess, number> = { "runs-as": 0, read: 1, write: 2, admin: 3, unscoped: 4 };

/** The stronger of two access types: a pair of nodes gets one edge, typed by the most it can do. */
export function strongerAccess(a: EdgeAccess | undefined, b: EdgeAccess): EdgeAccess {
  return a !== undefined && RANK[a] >= RANK[b] ? a : b;
}

type Typed = { access?: EdgeAccess | undefined; conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined };

/** The strongest level a grant gives with no condition: its own level, or the lower one a conditional edge carries. Undefined when every grant on it is conditional. */
export function unconditionalLevel(t: Typed | undefined): EdgeAccess | undefined {
  return t?.conditional === true ? t.unconditional : t?.access;
}

/**
 * Two grants over one pair of nodes: the type is the stronger one, and the edge is
 * conditional only when every grant at that strongest level is. A condition never lowers a
 * level, and a grant without one is never hidden behind a conditional one: a conditional
 * edge also carries the strongest level some grant gives with no condition (`unconditional`),
 * so an unconditional `write` stays visible under a conditional `admin`.
 */
export function mergeAccess(
  a: Typed | undefined,
  b: { access: EdgeAccess; conditional?: boolean | undefined; unconditional?: EdgeAccess | undefined },
): { access: EdgeAccess; conditional?: true; unconditional?: EdgeAccess } {
  const access = strongerAccess(a?.access, b.access);
  const holds = (t: Typed | undefined) => t?.access === access;
  const conditional = [a, b].filter(holds).every((t) => t?.conditional === true);
  if (!conditional) return { access };
  const floor = [unconditionalLevel(a), unconditionalLevel(b)].reduce<EdgeAccess | undefined>(
    (best, level) => (level === undefined || level === "runs-as" ? best : strongerAccess(best, level)),
    undefined,
  );
  return floor !== undefined && floor !== access ? { access, conditional: true, unconditional: floor } : { access, conditional: true };
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

/** Whether a policy expression is a JSON object with nothing in it: `"{}"` or `jsonencode({})`. */
function isEmptyDocument(expr: string | undefined): boolean {
  const text = expr?.trim();
  if (!text) return false;
  const inner = text.startsWith("jsonencode(") ? callArgument(text, "jsonencode") : text;
  if (inner === null) return false;
  const value = readVal(inner.trim());
  if (value?.t === "obj") return value.entries.length === 0;
  if (value?.t !== "str") return false;
  try {
    const parsed: unknown = JSON.parse(value.text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
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

/** Who a resource-based policy statement names: the values by principal type (`AWS`, `Service`, `Federated`, `CanonicalUser`), and whether it is a `NotPrincipal`. */
type PrincipalClause = { not: boolean; entries: Array<{ type: string; values: Val[] }> } | "unreadable";

type Statement = {
  /** The statement's Principal or NotPrincipal, absent for an identity policy. */
  principal?: PrincipalClause;
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

/** An operator that holds whatever the request looks like (`Null`, anything `...IfExists`, with or without a `ForAnyValue:` prefix): it never narrows when a grant applies. */
function neverNarrows(operator: string): boolean {
  const name = (operator.split(":").pop() ?? "").trim().toLowerCase();
  return name === "null" || name.endsWith("ifexists");
}

/** Whether a condition's values can rule a request out: not when there are none, and not when one of them is only wildcards (it matches anything). */
function narrowingValues(v: Val): boolean {
  const values = listOf(v);
  return values.length > 0 && !values.some((value) => value.t === "str" && !value.interpolated && /^\*+$/.test(value.text));
}

/**
 * Whether a Condition value is a real one: an object with at least one operator, each
 * holding at least one key, and at least one key that can rule a request out. An empty
 * object, a string or anything unreadable is not counted, and neither is a condition that
 * is always true (`Null`, `...IfExists`, a value that is only `*`): a statement is only
 * ever marked conditional on evidence, and when in doubt it is not.
 */
function isCondition(v: Val): boolean {
  if (v.t !== "obj" || v.entries.length === 0) return false;
  let narrows = false;
  for (const operator of v.entries) {
    if (operator.value.t !== "obj" || operator.value.entries.length === 0) return false;
    if (!neverNarrows(operator.key) && operator.value.entries.some((key) => narrowingValues(key.value))) narrows = true;
  }
  return narrows;
}

/** The Principal or NotPrincipal of a JSON statement: `"*"`, or an object of principal types. Anything else cannot be read. */
function principalClauseOf(st: Val): PrincipalClause | undefined {
  const named = valuesOf(st, "principal");
  const not = valuesOf(st, "notprincipal");
  if (named.length + not.length === 0) return undefined;
  const entries: Array<{ type: string; values: Val[] }> = [];
  for (const value of [...named, ...not]) {
    if (value.t === "str" && value.text === "*") entries.push({ type: "AWS", values: [value] });
    else if (value.t === "obj") for (const e of value.entries) entries.push({ type: e.key, values: listOf(e.value) });
    else return "unreadable";
  }
  return { not: not.length > 0, entries };
}

/** The `principals` and `not_principals` blocks of a policy document statement. A generated one (`dynamic`) cannot be read. */
function principalBlocksOf(statement: HclBlock): PrincipalClause | undefined {
  const blocks = statement.blocks.filter((b) => b.type === "principals" || b.type === "not_principals");
  if (statement.blocks.some((b) => b.type === "dynamic" && (b.labels[0] === "principals" || b.labels[0] === "not_principals"))) return "unreadable";
  if (blocks.length === 0) return undefined;
  const entries = blocks.map((b) => ({ type: stringValue(attributeOf(b, "type")) ?? "?", values: listOf(readVal(attributeOf(b, "identifiers") ?? "") ?? UNREADABLE) }));
  return { not: blocks.some((b) => b.type === "not_principals"), entries };
}

function statementOf(st: Val, conditionBlock = false, principal?: PrincipalClause): Statement {
  const conditional = conditionBlock || valuesOf(st, "condition", "conditions").some(isCondition);
  const actions = valuesOf(st, "action", "actions");
  const notActions = valuesOf(st, "notaction", "notactions");
  const resources = valuesOf(st, "resource", "resources");
  const notResources = valuesOf(st, "notresource", "notresources");
  // A statement with no Action or no Resource key is not "grants nothing": it is unknown.
  const clause = principal ?? principalClauseOf(st);
  return {
    ...(clause ? { principal: clause } : {}),
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
    out.push(statementOf(obj, b.blocks.some(isConditionBlock), principalBlocksOf(b)));
  }
  return out;
}

/** A static `condition { test, variable, values }` block that can rule a request out; a `dynamic` one, a `Null` or `...IfExists` test and a `*` value are not counted. */
function isConditionBlock(b: HclBlock): boolean {
  if (b.type !== "condition" || !["test", "variable", "values"].every((key) => attributeOf(b, key) !== undefined)) return false;
  const test = stringValue(attributeOf(b, "test"));
  if (test !== undefined && neverNarrows(test)) return false;
  const values = readVal(attributeOf(b, "values") ?? "");
  return values !== null && narrowingValues(values);
}

const READ_VERBS = ["get", "list", "describe", "head", "batchget", "query", "scan", "select", "lookup", "view", "search", "read", "receive", "decrypt", "verify"];
/**
 * Names that change who can use a resource. Most say so (policy, acl, grant, permission); the rest are the calls
 * that do it without the word: queue and topic attributes hold the resource policy, a public access block, an
 * ownership control, a snapshot or image attribute and a resource share decide who outside the account sees it, a
 * function URL can make a function public, and authorising snapshot access hands one to another account.
 */
const PERMISSION_NAME =
  /(policy|acl|grant|permission|passrole|assumerole|setqueueattributes|settopicattributes|publicaccessblock|ownershipcontrols|snapshotattribute|imageattribute|authorizesnapshotaccess|functionurlconfig|resourceshare)/;
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
function stringReach(
  text: string,
  owner: (address: string) => string | undefined,
  add: (id: string) => void,
  identities: Identities,
  undrawn: () => void,
): boolean {
  if (/[\\]|%\{|\$\$/.test(text)) return true;
  const named = identityArn(text);
  if (named) return identityReach(named, identities, add);
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
  if (wildcard === -1) {
    // A string with no reference and no wildcard names one resource, by its text: a drawn one if its name is there, else one the picture does not hold.
    if (!text.includes("${")) literalReach(text, identities, add, undrawn);
    return false;
  }
  const path = masked.search(new RegExp(`${HOLE}[/:]`));
  return path === -1 || wildcard < path + 2;
}

/**
 * How a literal ARN names a resource of a service whose resources the picture draws: the resource types and the
 * attribute that holds each one's name, and the name in the ARN's resource part. Only these are matched by name;
 * an ARN of any other service (a KMS key id, a log group) is a resource the picture does not hold.
 */
const ARN_NAMES = new Map<string, { types: Array<[string, string]>; nameOf: (resource: string) => string | undefined }>([
  ["s3", { types: [["aws_s3_bucket", "bucket"]], nameOf: (r) => r.split("/")[0] }],
  ["dynamodb", { types: [["aws_dynamodb_table", "name"]], nameOf: (r) => (r.startsWith("table/") ? r.slice(6).split("/")[0] : undefined) }],
  ["sqs", { types: [["aws_sqs_queue", "name"]], nameOf: (r) => r }],
  ["sns", { types: [["aws_sns_topic", "name"]], nameOf: (r) => r }],
  ["lambda", { types: [["aws_lambda_function", "function_name"]], nameOf: (r) => (r.startsWith("function:") ? r.slice(9).split(":")[0] : undefined) }],
  ["ecr", { types: [["aws_ecr_repository", "name"]], nameOf: (r) => (r.startsWith("repository/") ? r.slice(11) : undefined) }],
  // A secret's ARN ends in a dash and six random characters after its name.
  ["secretsmanager", { types: [["aws_secretsmanager_secret", "name"]], nameOf: (r) => (r.startsWith("secret:") ? r.slice(7).replace(/-[A-Za-z0-9]{6}$/, "") : undefined) }],
]);

/** The drawn resources a literal string names, or one the picture does not hold: that reaches "any resource" at the action's level. */
function literalReach(text: string, identities: Identities, add: (id: string) => void, undrawn: () => void): void {
  const parts = text.length > 1024 ? [] : text.split(":");
  const service = parts[0] === "arn" ? parts[2] : undefined;
  const entry = service === undefined ? undefined : ARN_NAMES.get(service);
  const name = entry && parts.length >= 6 ? entry.nameOf(parts.slice(5).join(":")) : undefined;
  const found = name === undefined ? [] : (identities.named.get(`${service}/${name.toLowerCase()}`) ?? []);
  for (const id of found) add(id);
  if (found.length === 0) undrawn();
}

/** The drawn roles and users a literal ARN may name, by the name the file gives them. */
type Identities = {
  /** Node ids by `role/<lowercase name>` or `user/<lowercase name>`, and by `<service>/<lowercase name>` for the resources of `ARN_NAMES`. */
  named: Map<string, string[]>;
  /** The kinds (`role`, `user`) with a drawn member whose name is not a plain string: an ARN may name it. */
  unsure: Set<string>;
};

const NO_IDENTITIES: Identities = { named: new Map(), unsure: new Set() };

const ARN_OPEN_PART = /^(?:[A-Za-z0-9-]*|\$\{[^{}:"]*\})$/;

/** A `role/...` or `user/...` ARN with a literal name: the partition and account may be a reference (a wildcard one is not read, so it stays broad); the name is the last path segment. */
function identityArn(text: string): { kind: "role" | "user"; name: string } | null {
  if (text.length > 512) return null;
  const parts = text.split(":");
  const [head, partition, service, region, account, resource] = parts;
  if (parts.length !== 6 || head !== "arn" || service !== "iam" || region !== "") return null;
  if (!ARN_OPEN_PART.test(partition ?? "") || !ARN_OPEN_PART.test(account ?? "")) return null;
  const m = /^(role|user)\/([A-Za-z0-9+=,.@_/-]+)$/.exec(resource ?? "");
  const name = m?.[2]?.split("/").pop();
  return m && name ? { kind: m[1] === "user" ? "user" : "role", name } : null;
}

/**
 * The drawn identity a literal ARN names, whatever its account (the file does not say which account a role is in).
 * A drawn identity whose name this reader cannot read might be it, so the ARN then reaches beyond what is drawn.
 * A name no drawn identity has is not drawn, which adds nothing, as for any other resource the picture leaves out.
 */
function identityReach(named: { kind: "role" | "user"; name: string }, identities: Identities, add: (id: string) => void): boolean {
  const found = identities.named.get(`${named.kind}/${named.name.toLowerCase()}`) ?? [];
  for (const id of found) add(id);
  return found.length === 0 && identities.unsure.has(named.kind);
}

/** `undrawn`: it also names something the picture does not hold, which is any resource at the grant's own level. */
type Reach = { targets: string[]; broad: boolean; undrawn: boolean };

/** Which drawn resources a Resource value points at, and whether it also reaches beyond them. */
function reachOf(values: Val[], owner: (address: string) => string | undefined, identities: Identities = NO_IDENTITIES): Reach {
  const reach: Reach = { targets: [], broad: false, undrawn: false };
  const add = (id: string | undefined) => {
    if (id && !reach.targets.includes(id)) reach.targets.push(id);
  };
  for (const v of values) {
    if (v.t === "list") {
      const inner = reachOf(v.items, owner, identities);
      for (const t of inner.targets) add(t);
      reach.broad ||= inner.broad;
      reach.undrawn ||= inner.undrawn;
    } else if (v.t === "obj") {
      reach.broad = true;
    } else if (v.t === "str") {
      if (stringReach(v.text, owner, add, identities, () => (reach.undrawn = true))) reach.broad = true;
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

/** Whether an action may change who can use what in IAM: `*`, or an `iam:` action (the service may be a pattern) that is admin by its name. */
function changesIam(action: string): boolean {
  if (action === "*") return true;
  const [service = "", name = ""] = action.split(":");
  return globMatches(service, "iam") && actionLevel({ t: "str", text: `iam:${name}`, interpolated: false, refs: [] }) === "admin";
}

/** Whether `pattern`, with `*` and `?`, matches `text`. */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * What a grant over more than the picture draws (`*`, a wildcard ARN, a variable) gives the identity that
 * holds it over itself: `admin` when an action in it changes IAM, `unscoped` when an action cannot be read
 * (or is a NotAction), null when no action could. Whatever it cannot bound may include the holder, as an own-ARN grant does.
 */
function selfLevelOfBroad(actions: Val[], notActions: boolean): "admin" | "unscoped" | null {
  if (notActions || actions.length === 0) return "unscoped";
  let level: "admin" | null = null;
  for (const a of actions) {
    if (actionLevel(a) === null) return "unscoped";
    if (a.t === "str" && changesIam(a.text.toLowerCase())) level = "admin";
  }
  return level;
}

/**
 * What an identity holds when its policy cannot be seen (a variable, a file, a managed policy that is not defined
 * here or in the table): an unscoped grant over anything, and over the identity itself, since a policy that
 * may say anything may rewrite the policy it is attached to. The second edge is kept apart as `self` by `readIam`.
 */
function opaqueGrant(source: string): IamEdge[] {
  return [
    { source, target: ANY_RESOURCE_ID, access: "unscoped" },
    { source, target: source, access: "unscoped" },
  ];
}

function edgesOfStatements(
  source: string,
  statements: Statement[] | null,
  owner: (address: string) => string | undefined,
  identities: Identities,
): IamEdge[] {
  if (statements === null) return opaqueGrant(source);
  const out: IamEdge[] = [];
  for (const st of statements) {
    if (st.actions.length === 0 || st.resources.length === 0) continue;
    const reach = st.notResources ? { targets: [], broad: true, undrawn: false } : reachOf(st.resources, owner, identities);
    const level = levelOf(st.actions, st.notActions);
    const conditional = st.conditional ? ({ conditional: true } as const) : {};
    for (const target of reach.targets) out.push({ source, target, access: level, ...conditional });
    if (reach.undrawn && !reach.broad) out.push({ source, target: ANY_RESOURCE_ID, access: level, ...conditional });
    if (reach.broad) {
      out.push({ source, target: ANY_RESOURCE_ID, access: "unscoped", ...conditional });
      const own = selfLevelOfBroad(st.actions, st.notActions);
      if (own) out.push({ source, target: source, access: own, ...conditional });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- AWS -- */

const GCP_FEDERATED_LABEL = "A federated identity";
const GCP_OTHER_LABEL = "Another principal";

/** What a policy attaches to: the kinds of identity AWS policies are given to, each with a fixed stand-in for one the picture does not draw. */
type HolderKind = "role" | "user" | "group";
type Holder = { id: string; standIn: boolean };
const AWS_HOLDER_STAND_INS: Record<HolderKind, { id: string; label: string }> = {
  role: { id: "principal-aws-role", label: "An IAM role (not drawn)" },
  user: { id: "principal-aws-user", label: "An IAM user (not drawn)" },
  group: { id: "principal-aws-group", label: "An IAM group (not drawn)" },
};

/**
 * The principals a resource-based policy (a bucket policy, a trust policy, a queue policy, a Lambda permission) can
 * name that the picture does not draw, one stand-in per kind, in fixed words: no account number, ARN or name from the
 * file reaches the model. `principal-federated` and `principal-other` are the same nodes the Google Cloud reader uses.
 */
type PrincipalClass = "anyone" | "account" | "service" | "federated" | "other";
const AWS_PRINCIPALS: Record<PrincipalClass, { id: string; label: string }> = {
  anyone: { id: "principal-aws-anyone", label: "Anyone (*)" },
  account: { id: "principal-aws-account", label: "An AWS account or principal (not drawn)" },
  service: { id: "principal-aws-service", label: "An AWS service" },
  federated: { id: "principal-federated", label: GCP_FEDERATED_LABEL },
  other: { id: "principal-other", label: GCP_OTHER_LABEL },
};

/** The stand-ins that stand for anyone at all: a grant from one is public. Reports rank these first. */
export const PUBLIC_PRINCIPAL_IDS: ReadonlySet<string> = new Set(["principal-aws-anyone", "principal-all-users", "principal-all-authenticated-users"]);

/** A source of a resource-policy edge: a drawn node, or a stand-in. `uncertain`: the principal may be anyone. */
type PolicySource = { id: string; drawn: boolean; cls: PrincipalClass | null; uncertain: boolean };

/** The resource types that carry a policy of their own, the attribute naming what it is on, and the attribute holding it. */
const AWS_RESOURCE_POLICIES = new Map<string, { target: string; policy: string }>([
  ["aws_s3_bucket_policy", { target: "bucket", policy: "policy" }],
  ["aws_sqs_queue_policy", { target: "queue_url", policy: "policy" }],
  ["aws_sns_topic_policy", { target: "arn", policy: "policy" }],
  ["aws_kms_key_policy", { target: "key_id", policy: "policy" }],
  ["aws_secretsmanager_secret_policy", { target: "secret_arn", policy: "policy" }],
  ["aws_ecr_repository_policy", { target: "repository", policy: "policy" }],
  ["aws_efs_file_system_policy", { target: "file_system_id", policy: "policy" }],
]);

/** Resources whose own `policy` attribute is their resource policy: it names what the resource is on itself. */
const AWS_INLINE_RESOURCE_POLICIES = new Set(["aws_s3_bucket", "aws_sqs_queue", "aws_sns_topic", "aws_kms_key", "aws_secretsmanager_secret"]);

/** The resource types that give one identity a policy: the attribute naming the identity, and whether the policy is a managed one attached by ARN. */
const AWS_POLICY_HOLDERS = new Map<string, { kind: HolderKind; attribute: string; attachment: boolean }>([
  ["aws_iam_role_policy", { kind: "role", attribute: "role", attachment: false }],
  ["aws_iam_role_policy_attachment", { kind: "role", attribute: "role", attachment: true }],
  ["aws_iam_user_policy", { kind: "user", attribute: "user", attachment: false }],
  ["aws_iam_user_policy_attachment", { kind: "user", attribute: "user", attachment: true }],
  ["aws_iam_group_policy", { kind: "group", attribute: "group", attachment: false }],
  ["aws_iam_group_policy_attachment", { kind: "group", attribute: "group", attachment: true }],
]);

function readAws(blocks: HclBlock[], owner: (address: string) => string | undefined, out: IamReading): void {
  const policies = new Map<string, HclBlock>();
  const documents = new Map<string, HclBlock>();
  for (const b of blocks) {
    if (b.type === "resource" && b.labels[0] === "aws_iam_policy") policies.set(`aws_iam_policy.${b.labels[1]}`, b);
    if (b.type === "data" && b.labels[0] === "aws_iam_policy_document") documents.set(`${b.labels[0]}.${b.labels[1]}`, b);
  }

  // The drawn roles and users a literal ARN may name.
  const identities: Identities = { named: new Map(), unsure: new Set() };
  for (const b of blocks) {
    const [type, label] = b.labels;
    const kind = type === "aws_iam_role" ? "role" : type === "aws_iam_user" ? "user" : undefined;
    const id = b.type === "resource" && kind && label ? owner(`${type}.${label}`) : undefined;
    if (!kind || !id) continue;
    const name = stringValue(attributeOf(b, "name"));
    if (name === undefined || /[$%{}\\]/.test(name)) identities.unsure.add(kind);
    else identities.named.set(`${kind}/${name.toLowerCase()}`, [...(identities.named.get(`${kind}/${name.toLowerCase()}`) ?? []), id]);
  }
  // The drawn resources a literal ARN of a service may name, by the name the file gives them. One whose name is not a plain string is named by no ARN here: an ARN it may have is any resource.
  for (const b of blocks) {
    const [type, label] = b.labels;
    if (b.type !== "resource" || !type || !label) continue;
    for (const [service, entry] of ARN_NAMES) {
      const attribute = entry.types.find(([t]) => t === type)?.[1];
      const id = attribute ? owner(`${type}.${label}`) : undefined;
      const name = attribute ? stringValue(attributeOf(b, attribute)) : undefined;
      if (!attribute || !id || name === undefined || /[$%{}\\]/.test(name)) continue;
      const key = `${service}/${name.toLowerCase()}`;
      identities.named.set(key, [...(identities.named.get(key) ?? []), id]);
    }
  }

  /**
   * Who holds a policy: the drawn identities the `role` (or `user`, `group`) expression names, and a stand-in for
   * the holder when it cannot be pinned to one drawn node (a string no drawn identity has, a variable, a data source,
   * a function). An expression that is more than one plain reference also gets the stand-in beside the drawn ones.
   * A policy is never dropped for want of a holder: its grants are the holder's, whoever that is.
   */
  const holdersOf = (expr: string | undefined, kind: HolderKind): Holder[] => {
    const found: Holder[] = [];
    const add = (id: string, standIn: boolean) => {
      if (!found.some((h) => h.id === id)) found.push({ id, standIn });
    };
    const unknown = () => add(AWS_HOLDER_STAND_INS[kind].id, true);
    const named = (text: string) => {
      const ids = identities.named.get(`${kind}/${text.toLowerCase()}`) ?? [];
      for (const id of ids) add(id, false);
      if (ids.length === 0 || identities.unsure.has(kind)) unknown();
    };
    const item = (value: Val): void => {
      if (value.t === "list") {
        for (const inner of value.items) item(inner);
      } else if (value.t === "obj") {
        unknown();
      } else if (value.t === "str") {
        const template = /^\$\{([^{}"]*)\}$/.exec(value.text);
        if (value.interpolated && !template) {
          for (const address of value.refs) {
            const id = owner(address);
            if (id) add(id, false);
          }
          unknown();
        } else if (template) item({ t: "expr", text: template[1] ?? "", refs: extractReferences(template[1] ?? "") });
        else named(value.text);
      } else {
        const target = resolveReference(value.text, owner);
        if (target.kind === "node") add(target.id, false);
        else {
          for (const address of value.refs) {
            const id = owner(address);
            if (id) add(id, false);
          }
          unknown();
        }
      }
    };
    let read: Val | null = null;
    try {
      read = expr === undefined ? null : readVal(expr);
    } catch {
      read = null;
    }
    if (read === null) {
      for (const address of expr ? extractReferences(expr) : []) {
        const id = owner(address);
        if (id) add(id, false);
      }
      unknown();
    } else item(read);
    return found;
  };

  /** Runs one holder's reading; the edges it adds from a stand-in are unscoped, as an unresolved GCP member's are. */
  const forHolder = (holder: Holder, run: (source: string) => void): void => {
    const start = out.edges.length;
    run(holder.id);
    if (!holder.standIn) return;
    const added = out.edges.splice(start);
    if (added.length > 0) {
      const stand = Object.values(AWS_HOLDER_STAND_INS).find((s) => s.id === holder.id);
      if (stand) out.principals.set(stand.id, stand.label);
    }
    for (const e of added) {
      if (e.target === e.source) continue;
      out.edges.push({ source: e.source, target: e.target, access: "unscoped", ...(e.conditional ? ({ conditional: true } as const) : {}) });
    }
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

  /** A policy the text does not show (generated, merged, a file): the holder has an unscoped grant. */
  const opaque = (source: string): void => {
    out.edges.push(...opaqueGrant(source));
  };

  /** Fails closed: a policy that cannot be read, or that makes the reader throw, is an unscoped grant. */
  const guarded = (source: string, read: () => IamEdge[]): IamEdge[] => {
    try {
      return read();
    } catch {
      return opaqueGrant(source);
    }
  };

  /** The grant of one policy expression. `holders` are the blocks that are consumed once it has drawn an edge. */
  const grant = (source: string, expr: string | undefined, holders: HclBlock[]): number => {
    const via: HclBlock[] = [];
    const edges = guarded(source, () => edgesOfStatements(source, statementsOf(expr, via), owner, identities));
    out.edges.push(...edges);
    if (edges.length > 0) for (const b of [...holders, ...via]) out.consumed.add(b);
    return edges.length;
  };

  /** The resource types of one service the file draws, as node ids, found once. */
  const drawnByService = new Map<string, string[]>();
  const drawnOf = (service: string): string[] => {
    const known = drawnByService.get(service);
    if (known) return known;
    const prefixes = Object.hasOwn(SERVICE_RESOURCE_TYPES, service) ? (SERVICE_RESOURCE_TYPES[service] ?? []) : [];
    const ids = new Set<string>();
    for (const b of blocks) {
      const [type, name] = b.labels;
      if (b.type !== "resource" || !type || !name || !prefixes.some((p) => type.startsWith(p))) continue;
      const id = owner(`${type}.${name}`);
      if (id) ids.add(id);
    }
    const found = [...ids];
    drawnByService.set(service, found);
    return found;
  };

  /**
   * The edges of a well-known managed policy. Every one of them grants on Resource `*`, so each
   * grant always reaches "Any resource (*)" at its own level, and also its level on each drawn
   * resource of its service (when there are some, not too many, and the attachment is under its
   * edge cap), the role's own node included: a policy that covers IAM may rewrite the role it is
   * attached to. A service the picture cannot draw has the account-wide edge alone.
   */
  const managedEdges = (source: string, arn: string): IamEdge[] | undefined => {
    const grants = managedPolicyGrants(arn);
    if (!grants) return undefined;
    const out: IamEdge[] = [];
    let drawn = 0;
    for (const [service, access, conditional] of grants) {
      const flag = conditional ? ({ conditional: true } as const) : {};
      out.push({ source, target: ANY_RESOURCE_ID, access, ...flag });
      // A policy that changes IAM may change the role it is attached to, however many roles are drawn.
      if (access === "admin" && (service === "iam" || (service === "*" && !MANAGED_WITHOUT_IAM_WRITE.has(arn)))) out.push({ source, target: source, access, ...flag });
      const targets = service === "*" ? [] : drawnOf(service);
      if (targets.length > 0 && targets.length <= MAX_MANAGED_TARGETS && drawn + targets.length <= MAX_MANAGED_EDGES) {
        for (const target of targets) out.push({ source, target, access, ...flag });
        drawn += targets.length;
      }
    }
    return out;
  };

  /**
   * A managed policy attached to `source`. A policy defined in this file is read. An ARN in
   * the bundled table of well-known AWS policies (AdministratorAccess, AmazonS3ReadOnlyAccess
   * and the like) gets the level and services the table gives it. Anything else (another ARN,
   * a data source, a variable) is a policy this reader cannot see, so it is unscoped.
   */
  const attach = (source: string, expr: string | undefined, holder: HclBlock | null): void => {
    const unscoped = () => {
      out.edges.push(...opaqueGrant(source));
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
        const arn = managedArn(item);
        let known: IamEdge[] | undefined;
        try {
          known = arn === null ? undefined : managedEdges(source, arn);
        } catch {
          known = undefined; // fails closed: the policy is then unscoped
        }
        if (known) {
          out.edges.push(...known);
          if (holder) out.consumed.add(holder);
          continue;
        }
        unscoped();
        continue;
      }
      grant(source, attributeOf(policy, "policy"), [policy, ...(holder ? [holder] : [])]);
    }
  };

  /** The stand-in node for a kind of principal, registered so the reader adds it once an edge starts there. */
  const standIn = (cls: PrincipalClass): string => {
    const stand = AWS_PRINCIPALS[cls];
    out.principals.set(stand.id, stand.label);
    return stand.id;
  };

  /** The nodes one principal value of one type names. A value that could be anyone at all is `uncertain`. */
  const sourcesOfValue = (type: string, value: Val): PolicySource[] => {
    const stand = (cls: PrincipalClass, uncertain = false): PolicySource => ({ id: standIn(cls), drawn: false, cls, uncertain });
    const drawnSource = (id: string): PolicySource => ({ id, drawn: true, cls: null, uncertain: false });
    const kind = type.toLowerCase();
    if (value.t === "list") return value.items.flatMap((item) => sourcesOfValue(type, item));
    if (value.t === "obj") return [stand("other", true)];
    if (kind === "service") return [stand("service")];
    if (kind === "federated") return [stand("federated")];
    if (kind === "canonicaluser") return [stand("other")];
    if (kind !== "aws") return [stand("other", true)];
    if (value.t === "str") {
      const template = /^\$\{([^{}"]*)\}$/.exec(value.text);
      if (template) return sourcesOfValue(type, { t: "expr", text: template[1] ?? "", refs: extractReferences(template[1] ?? "") });
      if (value.text === "*") return [stand("anyone")];
      const named = identityArn(value.text);
      if (named) {
        const found = identities.named.get(`${named.kind}/${named.name.toLowerCase()}`) ?? [];
        return found.length > 0 && !identities.unsure.has(named.kind) ? found.map(drawnSource) : [...found.map(drawnSource), stand("account")];
      }
      // An account id or an `arn:...:root`, written out or built from the account: some principal of that account.
      if (/^\d{12}$/.test(value.text) || value.text.endsWith(":root") || value.text.startsWith("arn:")) return [stand("account")];
      return [stand("other", true)];
    }
    const target = resolveReference(value.text, owner);
    if (target.kind === "node") return [drawnSource(target.id)];
    return [target.kind === "outside" ? stand("account") : stand("other", true)];
  };

  /** Who a statement's Principal names. No Principal, one that cannot be read and a NotPrincipal (everyone but them) cannot be bounded: they may be anyone. */
  const sourcesOfStatement = (st: Statement): PolicySource[] => {
    const clause = st.principal;
    const anyone = (): PolicySource[] => [{ id: standIn("anyone"), drawn: false, cls: "anyone", uncertain: true }];
    if (clause === undefined || clause === "unreadable") return [{ id: standIn("other"), drawn: false, cls: "other", uncertain: true }];
    if (clause.not) return anyone();
    const found = clause.entries.flatMap((entry) => entry.values.flatMap((value) => sourcesOfValue(entry.type, value)));
    if (found.length === 0) return [{ id: standIn("other"), drawn: false, cls: "other", uncertain: true }];
    return [...new Map(found.map((source) => [`${source.id}|${source.uncertain}`, source])).values()];
  };

  /** What the policy is on: the drawn node its attribute is exactly one reference to, else any resource, and then nothing it draws is better than unscoped. */
  const policyTarget = (expr: string | undefined): { id: string; exact: boolean } => {
    let read: Val | null = null;
    try {
      read = expr === undefined ? null : readVal(expr);
    } catch {
      read = null;
    }
    const text = read?.t === "expr" ? read.text : read?.t === "str" ? (/^\$\{([^{}"]*)\}$/.exec(read.text)?.[1] ?? "") : "";
    const target = text === "" ? undefined : resolveReference(text, owner);
    return target?.kind === "node" ? { id: target.id, exact: true } : { id: ANY_RESOURCE_ID, exact: false };
  };

  /**
   * The edges a resource-based policy draws into what it is on, from the principals it names. `trust` is a role's
   * assume-role policy: an action that only assumes the role is acting as it (`runs-as` from a drawn workload or a
   * service, `admin` from another account or identity, unscoped from anyone), as for a Google Cloud service account.
   * A policy that cannot be read is an unscoped grant from a principal that cannot be named.
   */
  const resourcePolicy = (target: { id: string; exact: boolean }, expr: string | undefined, trust: boolean, holders: HclBlock[]): void => {
    const via: HclBlock[] = [];
    let edges: IamEdge[];
    try {
      // A document with nothing in it (`"{}"`) names no principal and grants nothing.
      if (isEmptyDocument(expr)) return;
      const statements = statementsOf(expr, via);
      if (statements === null) edges = [{ source: standIn("other"), target: target.id, access: "unscoped" }];
      else {
        edges = [];
        for (const st of statements) {
          if (st.actions.length === 0) continue;
          const level = levelOf(st.actions, st.notActions);
          const assumes = trust && !st.notActions && st.actions.every((a) => a.t === "str" && a.text.toLowerCase().startsWith("sts:"));
          for (const source of sourcesOfStatement(st)) {
            let access: EdgeAccess = level;
            if (source.uncertain || level === "unscoped" || !target.exact) access = "unscoped";
            else if (assumes) access = source.drawn || source.cls === "service" ? "runs-as" : source.cls === "anyone" ? "unscoped" : "admin";
            edges.push({ source: source.id, target: target.id, access, ...(st.conditional ? ({ conditional: true } as const) : {}) });
          }
        }
      }
    } catch {
      edges = [{ source: standIn("other"), target: target.id, access: "unscoped" }];
    }
    out.edges.push(...edges);
    if (edges.length > 0) for (const b of [...holders, ...via]) out.consumed.add(b);
  };

  /** A Lambda permission: its `principal` may take its `action` on the function, narrowed by a source ARN, account or organisation. */
  const lambdaPermission = (b: HclBlock): void => {
    const target = policyTarget(attributeOf(b, "function_name"));
    const principal = readVal(attributeOf(b, "principal") ?? "") ?? UNREADABLE;
    const type = principal.t === "str" && /\.amazonaws\.com(\.cn)?$/.test(principal.text) ? "Service" : "AWS";
    const action = readVal(attributeOf(b, "action") ?? "");
    const level = action === null ? "unscoped" : levelOf([action], false);
    const conditional = ["source_arn", "source_account", "principal_org_id"].some((key) => attributeOf(b, key) !== undefined);
    for (const source of sourcesOfValue(type, principal)) {
      const access: EdgeAccess = source.uncertain || level === "unscoped" || !target.exact ? "unscoped" : level;
      out.edges.push({ source: source.id, target: target.id, access, ...(conditional ? ({ conditional: true } as const) : {}) });
    }
    out.consumed.add(b);
  };

  for (const b of blocks) {
    if (b.type !== "resource") continue;
    const [type, name] = b.labels;
    const holderAttribute = type ? AWS_POLICY_HOLDERS.get(type) : undefined;
    if (holderAttribute && type) {
      const { kind, attribute, attachment } = holderAttribute;
      for (const holder of holdersOf(attributeOf(b, attribute), kind)) {
        forHolder(holder, (source) => (attachment ? attach(source, attributeOf(b, "policy_arn"), b) : void grant(source, attributeOf(b, "policy"), [b])));
      }
    } else if (type === "aws_iam_policy_attachment") {
      // One attachment may name roles, users and groups together.
      for (const [attribute, kind] of [["roles", "role"], ["users", "user"], ["groups", "group"]] as const) {
        if (attributeOf(b, attribute) === undefined) continue;
        for (const holder of holdersOf(attributeOf(b, attribute), kind)) forHolder(holder, (source) => attach(source, attributeOf(b, "policy_arn"), b));
      }
    } else if (type === "aws_iam_role" && name) {
      const source = owner(`aws_iam_role.${name}`);
      if (!source) continue;
      for (const inline of b.blocks) {
        if (inline.type === "inline_policy") grant(source, attributeOf(inline, "policy"), []);
        // Generated policies: whatever they say, the role holds them.
        else if (inline.type === "dynamic" && inline.labels[0] === "inline_policy") opaque(source);
      }
      attach(source, attributeOf(b, "managed_policy_arns"), null);
      // Who may assume the role: a policy on the role, from the principals it names.
      if (attributeOf(b, "assume_role_policy") !== undefined) resourcePolicy({ id: source, exact: true }, attributeOf(b, "assume_role_policy"), true, []);
    } else if (type === "aws_lambda_permission") {
      lambdaPermission(b);
    } else if (type && AWS_RESOURCE_POLICIES.has(type)) {
      const spec = AWS_RESOURCE_POLICIES.get(type);
      if (spec) resourcePolicy(policyTarget(attributeOf(b, spec.target)), attributeOf(b, spec.policy), false, [b]);
    } else if (type === "aws_iam_instance_profile" && holdersOf(attributeOf(b, "role"), "role").some((h) => !h.standIn)) {
      out.consumed.add(b);
    }
    // A resource whose own `policy` is its resource policy is the resource it is on.
    const own = type && name && AWS_INLINE_RESOURCE_POLICIES.has(type) ? owner(`${type}.${name}`) : undefined;
    if (own && attributeOf(b, "policy") !== undefined) resourcePolicy({ id: own, exact: true }, attributeOf(b, "policy"), false, []);
  }
}

/**
 * The ARN text of a managed policy attached by a string: a literal in the `aws` partition, or
 * that with its partition taken from `data.aws_partition.<name>.partition`. Null for anything
 * else (a reference, a function, another template, another partition, a long string, an escape).
 */
function managedArn(item: Val): string | null {
  if (item.t !== "str" || item.text.length > 240 || item.text.includes("\\")) return null;
  const text = item.text;
  if (!item.interpolated) return text.startsWith("arn:aws:") ? text : null;
  // Only `arn:${data.aws_partition.<name>.partition}:...`: cut at the first brace instead of running a pattern over the rest.
  const open = "arn:${";
  if (!text.startsWith(open)) return null;
  const close = text.indexOf("}", open.length);
  if (close === -1 || text.indexOf("${", close) !== -1 || text.indexOf("%{") !== -1) return null;
  const reference = text.slice(open.length, close);
  return /^data\.aws_partition\.[A-Za-z_][\w-]*\.partition$/.test(reference) ? `arn:aws${text.slice(close + 1)}` : null;
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

/** The stand-in for the principal of a role assignment that the picture does not draw: its object id is a variable, a data source or text, and never reaches the model. */
const AZURE_PRINCIPAL = { id: "principal-azure", label: "An Azure principal (not drawn)" };

/** One reference to an attribute of an Azure resource: `azurerm_x.name.principal_id`, `azurerm_x.name.identity[0].principal_id`, with an index on the resource. */
const AZURE_PRINCIPAL_REFERENCE = /^azurerm_[a-z0-9_]+\.[A-Za-z_][\w-]*(?:\[(?:\d+|each\.key|count\.index)\])?(?:\.[A-Za-z_][\w-]*(?:\[\d+\])?)+$/;

function readAzure(blocks: HclBlock[], owner: (address: string) => string | undefined, out: IamReading): void {
  for (const b of blocks) {
    if (b.type !== "resource" || b.labels[0] !== "azurerm_role_assignment") continue;
    const principal = attributeOf(b, "principal_id") ?? "";
    let drawn: string | undefined;
    for (const address of extractReferences(principal)) {
      drawn = owner(address);
      if (drawn) break;
    }
    // Only exactly one reference to a drawn identity is that identity: anything else (a variable, a data-sourced group, a conditional) may be someone who is not drawn, and is a stand-in's unscoped grant.
    const exact = drawn !== undefined && AZURE_PRINCIPAL_REFERENCE.test(principal.trim());
    const sources: Array<{ id: string; standIn: boolean }> = [];
    if (drawn) sources.push({ id: drawn, standIn: false });
    if (!exact) sources.push({ id: AZURE_PRINCIPAL.id, standIn: true });

    for (const { id: source, standIn } of sources) {
      const unscoped: IamEdge = { source, target: ANY_RESOURCE_ID, access: "unscoped" };
      let edge: IamEdge;
      try {
        const roleName = stringValue(attributeOf(b, "role_definition_name"));
        const level: EdgeAccess = standIn ? "unscoped" : ((roleName === undefined ? null : azureRoleLevel(roleName)) ?? "unscoped");
        const target = azureScopeTarget(attributeOf(b, "scope") ?? "", owner);
        edge = target === undefined ? unscoped : { source, target, access: level };
      } catch {
        edge = unscoped;
      }
      out.edges.push(edge);
      if (standIn) out.principals.set(AZURE_PRINCIPAL.id, AZURE_PRINCIPAL.label);
    }
    out.consumed.add(b);
  }
}

/* ----------------------------------------------------------------- Google -- */

/**
 * The principals a Google Cloud grant can name that the picture does not draw, one stand-in
 * per kind of principal, in fixed words. A grant to `user:alice@example.com` is an edge from
 * "A person (user)": the address, the group, the domain and the member text never reach the
 * model, and however many a file names there are never more nodes than these. Several people with
 * a grant on one resource are one edge, typed by the strongest of their roles. A principal the
 * reader cannot classify is `other`: an edge is never dropped for want of a name.
 */
const GCP_PRINCIPALS = {
  user: "A person (user)",
  group: "A group",
  domain: "A whole domain",
  serviceAccount: "A service account (not drawn)",
  allUsers: "Anyone on the internet (allUsers)",
  allAuthenticatedUsers: "Any Google account (allAuthenticatedUsers)",
  federated: GCP_FEDERATED_LABEL,
  other: GCP_OTHER_LABEL,
} as const;

type GcpPrincipal = keyof typeof GCP_PRINCIPALS;

const gcpPrincipalId = (kind: GcpPrincipal) => `principal-${kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** What a member string's text before its first colon says it is. Matched by equality: nothing from the string is kept. */
const GCP_MEMBER_PREFIXES = new Map<string, GcpPrincipal>([
  ["user", "user"],
  ["group", "group"],
  ["domain", "domain"],
  ["serviceAccount", "serviceAccount"],
  ["principal", "federated"],
  ["principalSet", "federated"],
]);

/** The most resources, members, bindings and targets one file or grant is read for; past them the grant is unscoped, never dropped. */
const MAX_GCP_RESOURCES = 2000;
const MAX_GCP_MEMBERS = 500;
const MAX_GCP_BINDINGS = 1000;
const MAX_GCP_TARGETS = 50;
/** The most edges Google Cloud grants add to one file. Past it nothing more is drawn, and one unscoped edge says there was more. */
const MAX_GCP_EDGES = 2000;
/** The most work (grants, and the members of each) one file's Google Cloud grants may cost. A policy document read by many resources is read once and counted each time it is used; past this the rest is one unscoped edge, never dropped. */
const MAX_GCP_WORK = 200_000;
/** A condition's expression longer than this is not read: it is not counted as conditional. */
const MAX_GCP_CONDITION = 4000;
/** A member's text up to its first colon is a short word; a longer one is not a prefix this reader knows. */
const MAX_GCP_MEMBER_PREFIX = 32;
/** A resource type or a policy reference longer than this is not one this reader reads. */
const MAX_GCP_NAME = 200;
/** A role is a short name; a longer string is not one this reader can be sure of. */
const MAX_GCP_ROLE = 200;

const GCP_IAM_TYPE = /^google_([a-z0-9_]{1,80})_iam_(member|binding|policy)$/;

/** Resources that name who may read or write a bucket's objects by ACL rather than IAM: the principals they name reach the bucket unscoped. */
const GCP_ACL_TYPES = new Set([
  "google_storage_bucket_acl",
  "google_storage_bucket_access_control",
  "google_storage_default_object_acl",
  "google_storage_default_object_access_control",
  "google_storage_object_acl",
  "google_storage_object_access_control",
]);

/** A BigQuery dataset's own `access` blocks and the separate `google_bigquery_dataset_access` say who may reach a dataset without a role in IAM. */
const GCP_DATASET_TYPE = "google_bigquery_dataset";
const GCP_DATASET_ACCESS_TYPE = "google_bigquery_dataset_access";

/** The attribute that names what a resource-level grant is on, by the service in its type. */
const GCP_TARGET_ATTRIBUTES = new Map<string, readonly string[]>([
  ["storage_bucket", ["bucket"]],
  ["pubsub_topic", ["topic"]],
  ["pubsub_subscription", ["subscription"]],
  ["secret_manager_secret", ["secret_id"]],
  ["service_account", ["service_account_id"]],
  ["kms_key_ring", ["key_ring_id"]],
  ["kms_crypto_key", ["crypto_key_id"]],
  ["bigquery_dataset", ["dataset_id"]],
  ["cloud_run_service", ["service"]],
  ["cloud_run_v2_service", ["name"]],
  ["cloudfunctions_function", ["cloud_function"]],
  ["cloudfunctions2_function", ["cloud_function"]],
]);

/** Grants on a scope that holds many resources: they reach "Any resource" at their level, and nothing narrower is drawn. */
const GCP_BROAD_SCOPES = new Set(["project", "folder", "organization", "billing_account"]);

/** Attributes of a grant that are not what it is on. */
const GCP_NOT_A_TARGET = new Set([
  "role",
  "member",
  "members",
  "project",
  "etag",
  "policy_data",
  // Where a resource is, not which one: a zone or a location says nothing about the name.
  "location",
  "zone",
  "region",
  "folder",
  "org_id",
  "billing_account_id",
  // Meta-arguments: they say how or when a resource is made, never which one a grant is on.
  "depends_on",
  "count",
  "for_each",
  "lifecycle",
  "provider",
]);

/** Basic and predefined roles that can mint a key for, or act as, a service account, so they reach everything it does: `admin`, whatever their name says. */
const GCP_ADMIN_ROLES = new Set(["roles/editor", "roles/cloudbuild.builds.editor"]);

/** The roles that let a principal act as a service account. */
const GCP_TOKEN_CREATOR = "roles/iam.serviceAccountTokenCreator";
const GCP_IMPERSONATION_ROLES = new Set(["roles/iam.serviceAccountUser", GCP_TOKEN_CREATOR]);

type GcpLevel = "read" | "write" | "admin" | "unscoped" | "impersonate";

/**
 * The level a role grants, from its name alone. The basic roles are `owner` (admin), `editor`
 * (write) and `viewer` (read). A predefined role (`roles/<service>.<name>`) is read by the last
 * word of its name where that is unambiguous: `...Admin` is admin, `...Viewer` and `...Reader` are
 * read, `...Writer`, `...Editor` and `...Publisher` are write. A custom role, a role that is a
 * variable or a template, and every predefined role whose name is anything else is unscoped.
 */
function gcpRoleLevel(role: Val | undefined): GcpLevel {
  if (role?.t !== "str" || role.interpolated || role.text.length > MAX_GCP_ROLE) return "unscoped";
  const text = role.text;
  if (!/^roles\/[A-Za-z0-9_.]+$/.test(text)) return "unscoped";
  if (text === "roles/owner") return "admin";
  if (GCP_ADMIN_ROLES.has(text)) return "admin";
  if (text === "roles/viewer") return "read";
  if (GCP_IMPERSONATION_ROLES.has(text)) return "impersonate";
  const name = text.slice(text.indexOf(".") + 1);
  if (!text.includes(".") || name === "") return "unscoped";
  // The last word of a camelCase name: `networkAdmin` is `admin`, `securityReviewer` is not `viewer`.
  const last = (name.match(/[A-Z]?[a-z0-9]+$/)?.[0] ?? "").toLowerCase();
  if (last === "admin") return "admin";
  if (last === "viewer" || last === "reader") return "read";
  if (last === "writer" || last === "editor" || last === "publisher") return "write";
  return "unscoped";
}

/** A CEL expression with every string literal blanked, so a word inside a literal is never read as code; null when a literal is not closed. One pass. */
function celCode(text: string): string | null {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c !== '"' && c !== "'") {
      out += c;
      i++;
      continue;
    }
    const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    let j = i + quote.length;
    while (j < text.length && !text.startsWith(quote, j)) j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) return null;
    out += '""';
    i = j + quote.length;
  }
  return out;
}

/** The variables a CEL condition can look at: what is in the request and the resource. Without one the expression is a constant. */
const CEL_ROOT = /(?<![\w.])(?:request|resource|api|origin|destination)(?![\w])/g;
const CEL_TIME = /(?<![\w.])request\.time(?![\w.])/g;
/** `request.time` compared so that it ends (`<`, `<=`) or is pinned (`==`, `!=`), either way round. */
const CEL_TIME_ENDS = /request\.time\s*(?:<|<=|==|!=)|(?:>|>=|==|!=)\s*request\.time(?![\w.])/;

/**
 * Whether a CEL expression can rule a request out. It cannot when it only has literals (`true`, `1 == 1`,
 * a comparison of constants), compares a thing with itself, is an `||` beside a literal `true`/`false`, or
 * only puts a lower bound on `request.time` (a date that, once past, never narrows again). When it is
 * not clear, it does not count: a grant is marked conditional only on evidence.
 */
function gcpExpressionNarrows(expression: string): boolean {
  if (expression.length > MAX_GCP_CONDITION) return false;
  const code = celCode(expression);
  if (code === null) return false;
  const roots = code.match(CEL_ROOT) ?? [];
  if (roots.length === 0) return false;
  if (code.includes("||") && /(?<![\w.])(?:true|false)(?![\w.])/.test(code)) return false;
  if (/(?<![\w.])([\w.]+)\s*(?:==|>=|<=)\s*\1(?![\w.])/.test(code)) return false;
  const onlyTime = (code.match(CEL_TIME) ?? []).length === roots.length;
  return !(onlyTime && !CEL_TIME_ENDS.test(code));
}

/** Whether a `condition` block can rule a request out: it has an `expression` that is text, is not a constant and is not only a template. */
function isGcpCondition(b: HclBlock): boolean {
  if (b.type !== "condition") return false;
  const raw = attributeOf(b, "expression");
  if (raw === undefined) return false;
  const heredoc = raw.trim().startsWith("<<");
  const text = heredoc ? heredocBody(raw) : stringValue(raw);
  if (text === undefined || text === null) return false;
  // A quoted string still has its escapes: `\"` is a quote of the expression, not the end of one of its literals.
  const expression = (heredoc ? text : text.replace(/\\(["\\])/g, "$1")).trim();
  if (expression === "" || expression.toLowerCase() === "true") return false;
  // One `${...}` and nothing else is a value this reader cannot see: in doubt it is not counted.
  if (expression.startsWith("${") && expression.endsWith("}") && !expression.slice(2).includes("${")) return false;
  return gcpExpressionNarrows(expression);
}

/** A string with nothing in it to resolve: a name written out in the file. */
function isPlainName(expression: string): boolean {
  const read = readVal(expression);
  return read?.t === "str" && !read.interpolated && read.refs.length === 0 && read.text !== "";
}

type GcpGrant = {
  /** The block holding it, consumed once it has drawn an edge. */
  holder: HclBlock;
  principals: Val[];
  role: Val | undefined;
  conditional: boolean;
};

/** One principal an edge starts at: a drawn node (`kind` null) or a stand-in. `uncertain` when the member could be anyone, `allUsers` included. */
type GcpSource = { id: string; kind: GcpPrincipal | null; uncertain: boolean };

/** Principals whose edge to a service account they may impersonate is `unscoped`: the account's reach is open to anyone in the group, domain or internet. */
const GCP_OPEN_PRINCIPALS = new Set<GcpPrincipal | null>(["group", "domain", "allUsers", "allAuthenticatedUsers"]);

/** The edges one grant's target reaches: the drawn nodes it names, whether it also reaches something that cannot be pinned down, and whether it names a resource that is not drawn. */
type GcpReach = { ids: string[]; broad: boolean; undrawn: boolean };

function readGcp(blocks: HclBlock[], owner: (address: string) => string | undefined, out: IamReading): void {
  const documents = new Map<string, HclBlock>();
  for (const b of blocks) {
    if (b.type === "data" && b.labels[0] === "google_iam_policy" && b.labels[1]) documents.set(b.labels[1], b);
  }

  const principal = (kind: GcpPrincipal): string => {
    const id = gcpPrincipalId(kind);
    out.principals.set(id, GCP_PRINCIPALS[kind]);
    return id;
  };

  /** The nodes one member names: the drawn identities it points at, else the stand-in for its kind of principal. A member that is not text this reader can classify may be anyone, so it is `uncertain`. */
  const principalsOf = (member: Val): GcpSource[] => {
    const drawn = [...new Set(member.t === "list" || member.t === "obj" ? [] : member.refs.flatMap((address) => owner(address) ?? []))];
    const sources: GcpSource[] = drawn.map((id) => ({ id, kind: null, uncertain: false }));
    // An expression is more than one reference unless it is exactly one: `concat(["allUsers"], [google_service_account.a.member])` names a drawn account and may name anyone.
    if (drawn.length > 0 && (member.t === "str" || (member.t === "expr" && SIMPLE_REFERENCE.test(member.text.trim())))) return sources;
    const stand = (kind: GcpPrincipal, uncertain = false): GcpSource => ({ id: principal(kind), kind, uncertain });
    if (member.t !== "str") return [...sources, stand("other", true)];
    const text = member.text;
    if (text === "allUsers" || text === "allAuthenticatedUsers") return [...sources, stand(text)];
    const colon = text.indexOf(":");
    const kind = colon === -1 || colon > MAX_GCP_MEMBER_PREFIX ? undefined : GCP_MEMBER_PREFIXES.get(text.slice(0, colon));
    // A template that starts with something this reader cannot see could be anything.
    return [...sources, kind ? stand(kind) : stand("other", member.interpolated)];
  };

  /** Every principal a `member` or `members` value names. A list, `toset([...])` and `tolist([...])` are read; anything else is one principal that cannot be named. */
  const membersOf = (expr: string | undefined): Val[] => {
    if (expr === undefined) return [];
    let text = expr.trim();
    for (const wrapper of ["toset", "tolist"]) {
      const inner = text.startsWith(`${wrapper}(`) ? callArgument(text, wrapper) : null;
      if (inner !== null) text = inner.trim();
    }
    const read = readVal(text);
    if (read === null) return [UNREADABLE];
    return listOf(read).flatMap((item) => (item.t === "list" ? item.items : [item]));
  };

  /**
   * What a resource-level grant is on: the drawn nodes its target attribute points at, whether it also reaches
   * something this reader cannot pin down (a name, a variable, a module output), and whether it names a
   * resource that is not drawn, which reaches whatever that is: "any resource" at the grant's own level.
   */
  const reachOfTarget = (b: HclBlock, service: string): GcpReach => {
    const named = GCP_TARGET_ATTRIBUTES.get(service);
    const candidates = named ? [] : b.attributes.filter((a) => !GCP_NOT_A_TARGET.has(a.key));
    // A type with no target attribute that names its resource in text (a repository, a database) is on one this reader cannot match to a drawn node: any resource, whatever else points at.
    if (candidates.some((a) => isPlainName(a.value))) return { ids: [], broad: true, undrawn: false };
    const expressions = named ? named.flatMap((key) => attributeOf(b, key) ?? []) : candidates.map((a) => a.value);
    const ids: string[] = [];
    let broad = expressions.length === 0;
    let undrawn = false;
    let anyAddress = false;
    for (const expression of expressions) {
      const addresses = extractReferences(expression);
      // A literal name, a variable or a local could be any resource.
      if (addresses.length === 0 && named) broad = true;
      if (addresses.length > 0) anyAddress = true;
      for (const address of addresses) {
        const id = owner(address);
        if (id) {
          if (!ids.includes(id)) ids.push(id);
        } else if (address.startsWith("module.")) {
          broad = true;
        } else {
          undrawn = true;
        }
      }
    }
    // A type this reader has no target attribute for: it is on something if an attribute that is not a place points at a resource.
    if (!named && !anyAddress) broad = true;
    if (ids.length > MAX_GCP_TARGETS) {
      ids.length = MAX_GCP_TARGETS;
      broad = true;
    }
    return { ids, broad, undrawn };
  };

  const started = out.edges.length;
  let overflowed = false;
  let work = 0;
  /** Counts work against the file's budget; past it the rest is one unscoped edge. */
  const spend = (units: number): boolean => {
    work += units;
    if (work > MAX_GCP_WORK) overflowed = true;
    return !overflowed;
  };
  const edge = (source: string, target: string, access: EdgeAccess, conditional: boolean) => {
    if (out.edges.length - started >= MAX_GCP_EDGES) {
      overflowed = true;
      return;
    }
    out.edges.push({ source, target, access, ...(conditional ? ({ conditional: true } as const) : {}) });
  };

  /** The edges of one grant. `service` is the service in the type of the resource it is on (`project`, `storage_bucket`); `reach` replaces what its attributes point at. */
  const grant = (g: GcpGrant, service: string, targetBlock: HclBlock, reach?: GcpReach): number => {
    const before = out.edges.length;
    const level = gcpRoleLevel(g.role);
    if (!spend(1 + Math.min(g.principals.length, MAX_GCP_MEMBERS))) return 0;
    const members = g.principals.slice(0, MAX_GCP_MEMBERS);
    const found = members.flatMap(principalsOf);
    if (g.principals.length > MAX_GCP_MEMBERS) found.push({ id: principal("other"), kind: "other", uncertain: true });
    const sources = [...new Map(found.map((s) => [`${s.id}|${s.uncertain}`, s])).values()];

    // What a source gets on the thing it is granted on. A member that could be anyone is unscoped. A role to act as a service
    // account is `runs-as` only for a drawn workload or account; for anyone else it is `admin` (they hold all the account does),
    // for a group, a domain or the public `unscoped`, and on anything but a service account `unscoped`.
    const accessOf = (source: GcpSource, onServiceAccount: boolean): EdgeAccess => {
      if (source.uncertain || level === "unscoped") return "unscoped";
      if (level !== "impersonate") return level;
      if (!onServiceAccount) return "unscoped";
      if (source.kind === null) return "runs-as";
      return GCP_OPEN_PRINCIPALS.has(source.kind) ? "unscoped" : "admin";
    };

    if (GCP_BROAD_SCOPES.has(service)) {
      // Every resource in the project (or folder, or organisation): "Any resource", at the role's level. A role to act as a service account is unscoped here, as it reaches all of them.
      for (const source of sources) edge(source.id, ANY_RESOURCE_ID, accessOf(source, false), g.conditional);
    } else {
      const reached = reach ?? reachOfTarget(targetBlock, service);
      for (const source of sources) {
        for (const id of reached.ids) {
          const onServiceAccount = service === "service_account";
          if (id !== source.id || level !== "impersonate") {
            edge(source.id, id, accessOf(source, onServiceAccount), g.conditional);
          } else if (!onServiceAccount) {
            edge(source.id, id, "unscoped", g.conditional);
          } else if (g.role?.t === "str" && g.role.text === GCP_TOKEN_CREATOR) {
            // An account that may mint tokens for itself can sign as itself, whatever its own roles are: an escalation path, so `admin`. Acting as itself (`serviceAccountUser`) adds nothing.
            edge(source.id, id, "admin", g.conditional);
          }
        }
        // A target that cannot be pinned down is unscoped, whatever the role says; one that is not drawn is anything, at the role's level.
        if (reached.broad) edge(source.id, ANY_RESOURCE_ID, "unscoped", g.conditional);
        else if (reached.undrawn) edge(source.id, ANY_RESOURCE_ID, accessOf(source, false), g.conditional);
      }
    }
    return out.edges.length - before;
  };

  /** Fails closed: a grant that cannot be read, or makes the reader throw, is an unscoped grant from a principal that cannot be named. */
  const guarded = (holder: HclBlock, read: () => number, consume = true): void => {
    let drawn = 0;
    try {
      drawn = read();
    } catch {
      edge(principal("other"), ANY_RESOURCE_ID, "unscoped", false);
      drawn = 1;
    }
    if (drawn > 0 && consume) out.consumed.add(holder);
  };

  /** A policy document read once, however many resources use it: its bindings (up to the cap) and whether it may grant more than they show. */
  type GcpDocument = { bindings: Array<{ principals: Val[]; role: Val; conditional: boolean }>; partial: boolean };
  const documentCache = new Map<HclBlock, GcpDocument>();
  const readDocument = (document: HclBlock): GcpDocument => {
    const cached = documentCache.get(document);
    if (cached) return cached;
    const all = document.blocks.filter((x) => x.type === "binding");
    const read: GcpDocument = {
      bindings: all.slice(0, MAX_GCP_BINDINGS).map((binding) => ({
        principals: membersOf(attributeOf(binding, "members")),
        role: readVal(attributeOf(binding, "role") ?? "") ?? UNREADABLE,
        conditional: binding.blocks.some(isGcpCondition),
      })),
      // Bindings past the cap, or a document with an attribute this reader does not know, may grant more than was read.
      partial: all.length > MAX_GCP_BINDINGS || document.blocks.some((x) => x.type !== "binding" && x.type !== "audit_config"),
    };
    documentCache.set(document, read);
    return read;
  };

  /** A value that names a kind of principal by the attribute it is in (`user_by_email`, an ACL's `user-...` entity): the drawn node it points at, else a stand-in of that kind. */
  const ofKind = (value: Val | null, prefix: string): Val => {
    if (value && value.t !== "list" && value.t !== "obj" && value.refs.some((address) => owner(address))) return value;
    return { t: "str", text: prefix, interpolated: false, refs: [] };
  };

  /** The principal an ACL entity (`allUsers`, `user-a@b.com`, `group-...`, `domain-...`, `project-owners-...`) names. */
  const aclEntity = (value: Val): Val => {
    if (value.t === "list" || value.t === "obj") return UNREADABLE;
    if (value.refs.some((address) => owner(address))) return value;
    if (value.t !== "str") return value;
    const text = value.text;
    if (text === "allUsers" || text === "allAuthenticatedUsers") return value;
    if (text.startsWith("user-")) return ofKind(value, "user:");
    if (text.startsWith("group-")) return ofKind(value, "group:");
    if (text.startsWith("domain-")) return ofKind(value, "domain:");
    // A fully templated entity could be anyone; any other literal is a project team.
    return value.interpolated ? value : { t: "str", text: "project-team", interpolated: false, refs: [] };
  };

  /** Who a storage ACL names: its `role_entity` pairs (`READER:allUsers`), its `entity` and its canned `predefined_acl`. Nothing readable is a principal that cannot be named. */
  const aclMembers = (b: HclBlock): Val[] => {
    const found: Val[] = [];
    for (const item of membersOf(attributeOf(b, "role_entity"))) {
      const colon = item.t === "str" ? item.text.indexOf(":") : -1;
      if (item.t !== "str" || colon === -1) found.push(item.t === "str" ? UNREADABLE : item);
      else found.push(aclEntity({ ...item, text: item.text.slice(colon + 1) }));
    }
    const entity = attributeOf(b, "entity");
    if (entity !== undefined) found.push(aclEntity(readVal(entity) ?? UNREADABLE));
    const predefined = attributeOf(b, "predefined_acl");
    if (predefined !== undefined) {
      const read = readVal(predefined);
      const text = read?.t === "str" && !read.interpolated ? read.text : undefined;
      if (text === undefined) found.push(UNREADABLE);
      else if (text === "publicRead" || text === "publicReadWrite") found.push({ t: "str", text: "allUsers", interpolated: false, refs: [] });
      else if (text === "authenticatedRead") found.push({ t: "str", text: "allAuthenticatedUsers", interpolated: false, refs: [] });
      else found.push({ t: "str", text: "project-team", interpolated: false, refs: [] });
    }
    return found.length > 0 ? found : [UNREADABLE];
  };

  /** Who one BigQuery `access` entry (an `access` block, or a `google_bigquery_dataset_access`) names. */
  const datasetEntryMembers = (entry: HclBlock): Val[] => {
    const found: Val[] = [];
    const named = (key: string, prefix: string) => {
      const raw = attributeOf(entry, key);
      if (raw !== undefined) found.push(ofKind(readVal(raw), prefix));
    };
    named("user_by_email", "user:");
    named("group_by_email", "group:");
    named("domain", "domain:");
    const member = attributeOf(entry, "iam_member");
    if (member !== undefined) found.push(...membersOf(member));
    const special = attributeOf(entry, "special_group");
    if (special !== undefined) {
      const read = readVal(special);
      found.push(read?.t === "str" && !read.interpolated ? (read.text === "allAuthenticatedUsers" ? read : { ...read, text: "project-team" }) : UNREADABLE);
    }
    // An authorized view, dataset or routine reads the data on its own account.
    if (entry.blocks.some((x) => x.type === "view" || x.type === "dataset" || x.type === "routine")) found.push({ t: "str", text: "project-team", interpolated: false, refs: [] });
    if (entry.blocks.some((x) => x.type === "dynamic")) found.push(UNREADABLE);
    return found.length > 0 ? found : [UNREADABLE];
  };

  /** A grant with no role to read: whoever it names reaches what it is on, unscoped. */
  const unscopedGrant = (holder: HclBlock, principals: Val[], service: string, targetBlock: HclBlock, reach?: GcpReach): number =>
    grant({ holder, principals, role: UNREADABLE, conditional: false }, service, targetBlock, reach);

  let seen = 0;
  for (const b of blocks) {
    if (overflowed) break;
    if (b.type !== "resource") continue;
    const type = b.labels[0] ?? "";
    if (type.length > MAX_GCP_NAME) continue;
    const match = GCP_IAM_TYPE.exec(type);
    const service = match?.[1];
    const form = match?.[2];
    const isAcl = GCP_ACL_TYPES.has(type);
    const isDatasetAccess = type === GCP_DATASET_ACCESS_TYPE;
    const datasetEntries = type === GCP_DATASET_TYPE ? b.blocks.filter((x) => x.type === "access" || (x.type === "dynamic" && x.labels[0] === "access")) : [];
    if (!(service && form) && !isAcl && !isDatasetAccess && datasetEntries.length === 0) continue;
    if (++seen > MAX_GCP_RESOURCES) {
      // Past the cap nothing more is read, and what is left is one unscoped grant: understating would be worse than a plain one.
      overflowed = true;
      break;
    }

    if (isAcl) {
      guarded(b, () => unscopedGrant(b, aclMembers(b), "storage_bucket", b));
    } else if (isDatasetAccess) {
      guarded(b, () => unscopedGrant(b, datasetEntryMembers(b), "bigquery_dataset", b));
    } else if (datasetEntries.length > 0) {
      // The dataset is a drawn node; what its own `access` blocks name reaches that node, and is not a block this resource stops being.
      const self = owner(`${type}.${b.labels[1] ?? ""}`);
      const reach: GcpReach = { ids: self ? [self] : [], broad: !self, undrawn: false };
      guarded(
        b,
        () => datasetEntries.reduce((drawn, entry) => drawn + unscopedGrant(b, entry.type === "dynamic" ? [UNREADABLE] : datasetEntryMembers(entry), "bigquery_dataset", b, reach), 0),
        false,
      );
    } else if (form === "member") {
      guarded(b, () =>
        grant(
          { holder: b, principals: membersOf(attributeOf(b, "member")), role: readVal(attributeOf(b, "role") ?? "") ?? UNREADABLE, conditional: b.blocks.some(isGcpCondition) },
          service ?? "",
          b,
        ),
      );
    } else if (form === "binding") {
      guarded(b, () =>
        grant(
          { holder: b, principals: membersOf(attributeOf(b, "members")), role: readVal(attributeOf(b, "role") ?? "") ?? UNREADABLE, conditional: b.blocks.some(isGcpCondition) },
          service ?? "",
          b,
        ),
      );
    } else {
      // An authoritative policy: the bindings of the `google_iam_policy` it names, or, when it is not one this reader can see, an unscoped grant from a principal it cannot name.
      guarded(b, () => {
        const reference = (attributeOf(b, "policy_data") ?? "").trim();
        const ref = reference.length > MAX_GCP_NAME ? null : /^data\.google_iam_policy\.([A-Za-z_][\w-]*)\.policy_data$/.exec(reference);
        const document = ref?.[1] ? documents.get(ref[1]) : undefined;
        if (!document) {
          edge(principal("other"), ANY_RESOURCE_ID, "unscoped", false);
          return 1;
        }
        out.consumed.add(document);
        const read = readDocument(document);
        let drawn = 0;
        for (const binding of read.bindings) {
          if (overflowed) break;
          drawn += grant({ holder: b, principals: binding.principals, role: binding.role, conditional: binding.conditional }, service ?? "", b);
        }
        if (read.partial) {
          edge(principal("other"), ANY_RESOURCE_ID, "unscoped", false);
          drawn++;
        }
        return drawn;
      });
    }
  }
  // Past a cap, grants went unread or undrawn: say so with the widest edge there is, never by drawing less.
  if (overflowed) out.edges.push({ source: principal("other"), target: ANY_RESOURCE_ID, access: "unscoped" });
}

/* ------------------------------------------------------------------- read -- */

/**
 * Every grant the file makes to a drawn node, as edges. `owner` maps a Terraform address
 * (`aws_s3_bucket.data`, `module.api`) to the id of the node that block belongs to.
 */
export function readIam(blocks: HclBlock[], owner: (address: string) => string | undefined): IamReading {
  const reading: IamReading = { edges: [], consumed: new Set(), principals: new Map(), self: [] };
  // Whatever cloud the file is mostly on, every cloud's grants in it are read: each is typed by its own resource types, and one that no reader read would be a grant the picture understates.
  readAws(blocks, owner, reading);
  readAzure(blocks, owner, reading);
  readGcp(blocks, owner, reading);

  // One edge per pair, typed by the strongest grant.
  const merged = new Map<string, IamEdge>();
  for (const edge of reading.edges) {
    const key = `${edge.source}->${edge.target}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { source: edge.source, target: edge.target, ...mergeAccess(existing, edge) } : edge);
  }
  // A grant on oneself is not an edge: it is kept apart, and only where it is an escalation path (`admin`, or `unscoped` when the reader cannot tell).
  const all = [...merged.values()];
  reading.edges = all.filter((e) => e.source !== e.target);
  reading.self = all.filter((e) => e.source === e.target && (e.access === "admin" || e.access === "unscoped"));
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
  // Google Cloud: a Cloud Run revision, a function, a node pool and a Compute instance's `service_account` block.
  "service_account",
  "service_account_email",
  "service_account_name",
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
      // A Compute instance names its service account in the `email` of a `service_account` block.
      if (!RUNS_AS_KEYS.has(a.key) && !(a.key === "email" && block.type === "service_account")) continue;
      for (const address of extractReferences(a.value)) {
        for (const resolved of profiles.get(address) ?? [address]) if (!found.includes(resolved)) found.push(resolved);
      }
    }
    for (const nested of block.blocks) visit(nested);
  };
  for (const b of workload) visit(b);
  return found;
}
