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

/* ------------------------------------------------------------ value reader -- */

/** A literal Terraform value, as far as this reader needs one. */
type Val =
  | { t: "obj"; entries: Array<{ key: string; value: Val }> }
  | { t: "list"; items: Val[] }
  | { t: "str"; text: string; interpolated: boolean; refs: string[] }
  | { t: "expr"; text: string; refs: string[] };

class Unreadable extends Error {}

function skipString(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === '"') return i + 1;
    else if (c === "$" && s[i + 1] === "{") i = skipBraces(s, i + 1);
    else i++;
  }
  throw new Unreadable();
}

function skipBraces(s: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      i = skipString(s, i);
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

function readValue(s: string, from: number, depth: number): [Val, number] {
  if (depth > 12) throw new Unreadable();
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
        const m = /^[A-Za-z0-9_.-]+/.exec(s.slice(j));
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
    return readValue(text, 0, 0)[0];
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
      else if (c === ")" && --depth === 0) return expr.slice(begin, i);
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
  const convert = (v: unknown): Val | null => {
    if (typeof v === "string") {
      const restored = v.replace(/\uE000(\d+)\uE001/g, (_, n: string) => holes[Number(n)] ?? "");
      return { t: "str", text: restored, interpolated: holes.length > 0 && restored.includes("${"), refs: extractReferences(JSON.stringify(restored)) };
    }
    if (Array.isArray(v)) {
      const converted = v.map(convert);
      return converted.every((x) => x !== null) ? { t: "list", items: converted as Val[] } : null;
    }
    if (v !== null && typeof v === "object") {
      const entries: Array<{ key: string; value: Val }> = [];
      for (const [key, inner] of Object.entries(v)) {
        const value = convert(inner);
        if (!value) return null;
        entries.push({ key, value });
      }
      return { t: "obj", entries };
    }
    return { t: "expr", text: String(v), refs: [] };
  };
  return convert(parsed);
}

/** The text of a heredoc expression, or null when the expression is not one. */
function heredocBody(expr: string): string | null {
  const m = /^<<-?\s*([A-Za-z_][A-Za-z0-9_]*)[^\n]*\n([\s\S]*?)\n\s*\1\s*$/.exec(expr.trim());
  return m ? (m[2] ?? null) : null;
}

/* ---------------------------------------------------------------- policies -- */

type Statement = {
  actions: Val[];
  notActions: boolean;
  resources: Val[];
  notResources: boolean;
};

const norm = (key: string) => key.toLowerCase().replace(/_/g, "");

function listOf(v: Val | undefined): Val[] {
  if (!v) return [];
  return v.t === "list" ? v.items : [v];
}

function entry(obj: Val, ...names: string[]): Val | undefined {
  if (obj.t !== "obj") return undefined;
  return obj.entries.find((e) => names.includes(norm(e.key)))?.value;
}

function isDeny(effect: Val | undefined): boolean {
  return effect?.t === "str" && effect.text.toLowerCase() === "deny";
}

/** The Allow statements of a policy document value, or null when it cannot be read. */
function statementsOfDocument(doc: Val): Statement[] | null {
  const list = entry(doc, "statement");
  if (!list) return null;
  const out: Statement[] = [];
  for (const st of listOf(list)) {
    if (st.t !== "obj") return null;
    if (isDeny(entry(st, "effect"))) continue;
    out.push(statementOf(st));
  }
  return out;
}

function statementOf(st: Val): Statement {
  const notActions = entry(st, "notaction", "notactions");
  const notResources = entry(st, "notresource", "notresources");
  return {
    actions: listOf(entry(st, "action", "actions") ?? notActions),
    notActions: notActions !== undefined,
    resources: listOf(entry(st, "resource", "resources") ?? notResources),
    notResources: notResources !== undefined,
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
    const obj: Val = {
      t: "obj",
      entries: b.attributes.flatMap((a) => {
        const value = readVal(a.value);
        return value ? [{ key: a.key, value }] : [];
      }),
    };
    if (isDeny(entry(obj, "effect"))) continue;
    out.push(statementOf(obj));
  }
  return out;
}

const READ_VERB = /^(Get|List|Describe|Head|BatchGet|Query|Scan|Select|Lookup|View|Search|Read|Receive|Decrypt|Verify)(?![a-z])/;
const PERMISSION_NAME = /(Policy|Acl|Grant|Permission|PassRole|AssumeRole)/;

/** The level one action grants, from its name alone. Null when the action is not a plain string. */
function actionLevel(action: Val): "read" | "write" | "admin" | null {
  if (action.t !== "str" || action.interpolated) return null;
  const text = action.text.trim();
  if (text === "*") return "admin";
  const [service = "", name = ""] = text.split(":");
  if (name === "") return null;
  if (name === "*") return "admin";
  const prefix = name.includes("*") ? name.slice(0, name.indexOf("*")) : name;
  const reads = READ_VERB.test(prefix);
  if (service.toLowerCase() === "iam" || service.toLowerCase() === "organizations") return reads ? "read" : "admin";
  if (reads) return "read";
  return PERMISSION_NAME.test(name) ? "admin" : "write";
}

/** A literal that names everything: `*`, or an ARN whose resource part is `*` or a wildcard service. */
function isBroad(literal: string): boolean {
  const text = literal.trim();
  if (text === "*") return true;
  if (!text.startsWith("arn:")) return false;
  const parts = text.split(":");
  if (parts[2] === "*") return true;
  const resource = parts.slice(5).join(":");
  return resource === "*" || resource.startsWith("*");
}

type Reach = { targets: string[]; broad: boolean };

/**
 * Which drawn resources a Resource value points at, and whether it also reaches beyond
 * them. A reference to something that is not drawn is a scoped grant to a thing the
 * picture leaves out, so it adds nothing; a value with no reference and nothing literal
 * to read is unknown, and counts as broad.
 */
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
      continue;
    }
    if (v.t === "obj") {
      reach.broad = true;
      continue;
    }
    for (const ref of v.refs) add(owner(ref));
    if (v.t === "str") {
      const bare = v.text.replace(/\$\{[^}]*\}/g, "");
      if (v.refs.length === 0 && v.interpolated && bare === "") reach.broad = true;
      else if (isBroad(v.text.replace(/\$\{[^}]*\}/g, "x"))) reach.broad = true;
    } else if (v.refs.length === 0 && !/\bdata\.[a-z0-9_]+\.[A-Za-z_]/.test(v.text)) {
      reach.broad = true;
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
    for (const target of reach.targets) if (target !== source) out.push({ source, target, access: level });
    if (reach.broad) out.push({ source, target: ANY_RESOURCE_ID, access: "unscoped" });
  }
  return out;
}

/* -------------------------------------------------------------------- AWS -- */

const ADMIN_POLICY = /policy\/AdministratorAccess\b/;

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

  /** The statements of a policy expression, or null when it is not text this reader can see. */
  const statementsOf = (expr: string | undefined): Statement[] | null => {
    const text = expr?.trim();
    if (!text) return null;
    const ref = /^data\.(aws_iam_policy_document)\.([A-Za-z_][\w-]*)\.json$/.exec(text);
    if (ref) {
      const doc = documents.get(`${ref[1]}.${ref[2]}`);
      if (!doc) return null;
      out.consumed.add(doc);
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

  const grant = (source: string, expr: string | undefined) => {
    out.edges.push(...edgesOfStatements(source, statementsOf(expr), owner));
  };

  const attach = (source: string, expr: string | undefined) => {
    if (!expr) return;
    for (const address of extractReferences(expr)) {
      const policy = policies.get(address);
      if (!policy) continue;
      out.consumed.add(policy);
      grant(source, attributeOf(policy, "policy"));
    }
    if (ADMIN_POLICY.test(expr)) out.edges.push({ source, target: ANY_RESOURCE_ID, access: "unscoped" });
  };

  for (const b of blocks) {
    if (b.type !== "resource") continue;
    const [type, name] = b.labels;
    if (type === "aws_iam_role_policy") {
      const sources = principalsOf(attributeOf(b, "role"));
      if (sources.length > 0) out.consumed.add(b);
      for (const source of sources) grant(source, attributeOf(b, "policy"));
    } else if (type === "aws_iam_role_policy_attachment" || type === "aws_iam_policy_attachment") {
      const sources = principalsOf(attributeOf(b, type === "aws_iam_policy_attachment" ? "roles" : "role"));
      if (sources.length > 0) out.consumed.add(b);
      for (const source of sources) attach(source, attributeOf(b, "policy_arn"));
    } else if (type === "aws_iam_role" && name) {
      const source = owner(`aws_iam_role.${name}`);
      if (!source) continue;
      for (const inline of b.blocks) if (inline.type === "inline_policy") grant(source, attributeOf(inline, "policy"));
      attach(source, attributeOf(b, "managed_policy_arns"));
    } else if (type === "aws_iam_instance_profile" && principalsOf(attributeOf(b, "role")).length > 0) {
      out.consumed.add(b);
    }
  }
}

/* ------------------------------------------------------------------ Azure -- */

/** The level a built-in Azure role grants, from its name. Null for a role that is not recognised. */
function azureRoleLevel(name: string): "read" | "write" | "admin" | null {
  const role = name.trim();
  if (/^(owner|user access administrator|role based access control administrator)$/i.test(role)) return "admin";
  if (/(\badministrator\b|\bdata owner\b|\bowner\b)/i.test(role)) return "admin";
  if (/(reader|viewer|receiver|secrets user)$/i.test(role)) return "read";
  if (/(contributor|officer|sender|operator|writer|crypto user)$/i.test(role)) return "write";
  return null;
}

/** Whether a scope expression covers a whole resource group, subscription or management group. */
function isWideScope(expr: string): boolean {
  if (/azurerm_(resource_group|subscription|management_group)|data\.azurerm_(subscription|client_config)/.test(expr)) return true;
  const literal = stringValue(expr.trim());
  if (literal === undefined) return false;
  return /^\/subscriptions\/[^/]+(\/resourceGroups\/[^/]+)?\/?$/i.test(literal) || /^\/providers\/Microsoft\.Management\//i.test(literal);
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
    out.consumed.add(b);

    const roleName = stringValue(attributeOf(b, "role_definition_name"));
    const level: EdgeAccess = (roleName === undefined ? null : azureRoleLevel(roleName)) ?? "unscoped";

    const scope = attributeOf(b, "scope") ?? "";
    const targets: string[] = [];
    for (const address of extractReferences(scope)) {
      const id = owner(address);
      if (id && id !== source && !targets.includes(id)) targets.push(id);
    }
    for (const target of targets) out.edges.push({ source, target, access: level });
    const unknown =
      extractReferences(scope).length === 0 && stringValue(scope.trim()) === undefined && !/\bdata\.[a-z0-9_]+\.[A-Za-z_]/.test(scope);
    if (isWideScope(scope) || unknown) out.edges.push({ source, target: ANY_RESOURCE_ID, access: "unscoped" });
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
    merged.set(key, existing ? { ...existing, access: strongerAccess(existing.access, edge.access) } : edge);
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
