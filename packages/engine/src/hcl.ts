// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A small, dependency-free HCL reader and writer for the subset Terragram needs:
 * blocks with labels, attributes, nested blocks, and enough expression awareness to
 * find `type.name.attr` references.
 *
 * It is deliberately NOT a full HCL implementation — it never evaluates expressions,
 * resolves variables, or validates syntax. It is string-, comment- and heredoc-aware
 * structural scanning, which is exactly what reading a resource graph back out of a
 * file needs. Being pure keeps it usable in any host, a browser included.
 *
 * The writer is the other half: the emitter builds `HclBlock` values and renders them
 * here, so emission and parsing share one shape and the round-trip test is meaningful.
 */

type HclAttribute = {
  key: string;
  /** The raw expression text, exactly as written (quotes included for strings). */
  value: string;
};

export type HclBlock = {
  /** `resource`, `module`, `data`, `variable`, `output`, `provider`, `terraform`. */
  type: string;
  labels: string[];
  attributes: HclAttribute[];
  blocks: HclBlock[];
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_-]/;

/** Advance past whitespace and comments, returning the next code offset. */
function skipTrivia(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "#" || (ch === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

/** End offset (exclusive) of a quoted string that starts at `start`. */
function stringEnd(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return src.length;
}

/** End offset (exclusive) of a heredoc whose `<<` or `<<-` marker starts at `start`. */
function heredocEnd(src: string, start: number): number {
  let i = start + 2;
  if (src[i] === "-") i++;
  let tag = "";
  while (i < src.length && IDENT_CHAR.test(src[i] ?? "")) {
    tag += src[i];
    i++;
  }
  if (!tag) return i;
  // The terminator is the tag alone on a line (leading whitespace allowed for <<-).
  const terminator = new RegExp(`^[ \\t]*${tag}[ \\t]*$`, "m");
  const rest = src.slice(i);
  const match = terminator.exec(rest);
  return match ? i + match.index + match[0].length : src.length;
}

function isHeredocStart(src: string, i: number): boolean {
  if (src[i] !== "<" || src[i + 1] !== "<") return false;
  const next = src[i + 2] === "-" ? src[i + 3] : src[i + 2];
  return !!next && IDENT_START.test(next);
}

/**
 * Read an attribute value starting at `start`: everything up to the end of the
 * expression. Brackets, braces, parens, strings and heredocs are balanced, so a
 * multi-line map, list or heredoc is captured whole.
 */
function readValue(src: string, start: number): { value: string; end: number } {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === '"') {
      i = stringEnd(src, i);
      continue;
    }
    if (isHeredocStart(src, i)) {
      i = heredocEnd(src, i);
      continue;
    }
    if (ch === "#" || (ch === "/" && src[i + 1] === "/")) {
      if (depth === 0) break;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break;
      depth--;
      i++;
      continue;
    }
    if (ch === "\n" && depth === 0) break;
    i++;
  }
  return { value: src.slice(start, i).trim(), end: i };
}

type BodyResult = { attributes: HclAttribute[]; blocks: HclBlock[]; end: number };

/** Parse a block body (between braces) or the top level when `top` is set. */
function parseBody(src: string, start: number, top: boolean): BodyResult {
  const attributes: HclAttribute[] = [];
  const blocks: HclBlock[] = [];
  let i = start;

  while (i < src.length) {
    i = skipTrivia(src, i);
    if (i >= src.length) break;
    if (src[i] === "}") {
      if (!top) return { attributes, blocks, end: i + 1 };
      i++; // A stray brace at the top level — skip rather than abort the file.
      continue;
    }

    const identStart = i;
    if (!IDENT_START.test(src[i] ?? "")) {
      i++;
      continue;
    }
    while (i < src.length && IDENT_CHAR.test(src[i] ?? "")) i++;
    const ident = src.slice(identStart, i);

    const afterIdent = skipTrivia(src, i);
    const next = src[afterIdent] ?? "";

    if (next === "=" && src[afterIdent + 1] !== "=") {
      const read = readValue(src, skipTrivia(src, afterIdent + 1));
      attributes.push({ key: ident, value: read.value });
      i = read.end;
      continue;
    }

    // A block: zero or more labels (quoted or bare) then `{`.
    const labels: string[] = [];
    let j = afterIdent;
    while (j < src.length) {
      j = skipTrivia(src, j);
      const ch = src[j] ?? "";
      if (ch === '"') {
        const end = stringEnd(src, j);
        labels.push(src.slice(j + 1, end - 1));
        j = end;
        continue;
      }
      if (ch === "{") break;
      if (IDENT_START.test(ch)) {
        const s = j;
        while (j < src.length && IDENT_CHAR.test(src[j] ?? "")) j++;
        labels.push(src.slice(s, j));
        continue;
      }
      break;
    }

    if (src[j] === "{") {
      const body = parseBody(src, j + 1, false);
      blocks.push({ type: ident, labels, attributes: body.attributes, blocks: body.blocks });
      i = body.end;
      continue;
    }

    // Not an attribute and not a block — skip the line and keep going.
    while (i < src.length && src[i] !== "\n") i++;
  }

  return { attributes, blocks, end: i };
}

/** Parse a Terraform document into its top-level blocks. Never throws. */
export function parseHcl(src: string): HclBlock[] {
  return parseBody(src, 0, true).blocks;
}

/** Look up one attribute's raw expression on a block. */
export function attributeOf(block: HclBlock, key: string): string | undefined {
  return block.attributes.find((a) => a.key === key)?.value;
}

/** An attribute's value with surrounding quotes removed, when it is a plain string. */
export function stringValue(expr: string | undefined): string | undefined {
  if (expr === undefined) return undefined;
  const trimmed = expr.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

const REFERENCE_RE = /\b([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/g;

/** Terraform address prefixes that are never a reference between components.
 *  `module` is deliberately NOT here: `module.functions.lambda_function_url` is
 *  how one module-emitted component points at another. */
const NON_RESOURCE_PREFIXES = new Set([
  "var",
  "local",
  "each",
  "count",
  "path",
  "terraform",
  "data",
  "self",
]);

/**
 * Pull `type.name` resource addresses (and `module.name` addresses) out of an
 * expression. Skips `var.`/`local.` and friends, and ignores text inside plain
 * string literals unless it is interpolated — `"${azurerm_service_plan.web.id}"` is
 * a reference, `"a.b"` is not.
 */
export function extractReferences(expr: string): string[] {
  const found: string[] = [];
  for (const segment of interpolatedSegments(expr)) {
    REFERENCE_RE.lastIndex = 0;
    let match = REFERENCE_RE.exec(segment);
    while (match !== null) {
      const head = match[1];
      const name = match[2];
      if (head && name && !NON_RESOURCE_PREFIXES.has(head)) {
        const address = `${head}.${name}`;
        if (!found.includes(address)) found.push(address);
      }
      match = REFERENCE_RE.exec(segment);
    }
  }
  return found;
}

/**
 * The parts of an expression that Terraform evaluates: everything outside string
 * literals, plus the inside of every `${...}` interpolation.
 */
function interpolatedSegments(expr: string): string[] {
  const segments: string[] = [];
  let i = 0;
  let plain = "";
  while (i < expr.length) {
    const ch = expr[i] ?? "";
    if (ch === '"') {
      const end = stringEnd(expr, i);
      const literal = expr.slice(i + 1, end - 1);
      let k = 0;
      while (k < literal.length) {
        const open = literal.indexOf("${", k);
        if (open === -1) break;
        let depth = 1;
        let j = open + 2;
        while (j < literal.length && depth > 0) {
          if (literal[j] === "{") depth++;
          else if (literal[j] === "}") depth--;
          if (depth === 0) break;
          j++;
        }
        segments.push(literal.slice(open + 2, j));
        k = j + 1;
      }
      i = end;
      continue;
    }
    plain += ch;
    i++;
  }
  if (plain.trim()) segments.push(plain);
  return segments;
}

/* ------------------------------------------------------------------ writer -- */

function indent(depth: number): string {
  return "  ".repeat(depth);
}

/**
 * The `=` alignment column for each attribute, matching `terraform fmt`.
 *
 * fmt aligns a RUN of consecutive single-line attributes, and a multi-line value
 * ends the run it is in — so `tags = {` is not padded out to the width of an
 * `instance_type` above it, and the attribute after the map starts a fresh run.
 * Aligning the whole block to one width is what made every emitted document
 * non-canonical, which `terraform fmt -check` in the emit gate now catches.
 */
function alignWidths(attributes: HclAttribute[]): number[] {
  const widths = new Array<number>(attributes.length).fill(0);
  let start = 0;
  const close = (end: number) => {
    if (end < start) return;
    const width = attributes
      .slice(start, end + 1)
      .reduce((w, a) => Math.max(w, a.key.length), 0);
    for (let j = start; j <= end; j++) widths[j] = width;
    start = end + 1;
  };
  for (let i = 0; i < attributes.length; i++) {
    if (!(attributes[i]?.value ?? "").includes("\n")) continue;
    // A multi-line attribute is a run of one: it closes the run above it and
    // takes no padding of its own (`tags = {`, never `tags          = {`).
    close(i - 1);
    close(i);
  }
  close(attributes.length - 1);
  return widths;
}

function renderAt(block: HclBlock, depth: number): string {
  const pad = indent(depth);
  const labels = block.labels.map((l) => ` "${l}"`).join("");
  const widths = alignWidths(block.attributes);
  const lines: string[] = [`${pad}${block.type}${labels} {`];

  for (const [index, attribute] of block.attributes.entries()) {
    const width = widths[index] ?? attribute.key.length;
    const gap = " ".repeat(Math.max(1, width - attribute.key.length + 1));
    lines.push(`${pad}${indent(1)}${attribute.key}${gap}= ${reindentValue(attribute.value, depth + 1)}`);
  }

  for (const nested of block.blocks) {
    if (lines.length > 1) lines.push("");
    lines.push(renderAt(nested, depth + 1));
  }

  lines.push(`${pad}}`);
  return lines.join("\n");
}

/**
 * Re-indent a multi-line expression (a map or list) to sit under its key.
 *
 * The expression arrives already indented RELATIVE to its own opening brace — a
 * map body at two spaces, its closing brace at zero — so each line is prefixed
 * with the attribute's own indent and that relative shape is kept. Flattening
 * every line to the same column (which this did) put a map's body at the same
 * depth as the key holding it, and no `terraform fmt` agrees with that.
 */
function reindentValue(value: string, depth: number): string {
  if (!value.includes("\n")) return value;
  const [first, ...rest] = value.split("\n");
  // Idempotent: a value that was already placed at some depth — read back by
  // `mapEntries` when a wire adds an entry to an existing map, or parsed from a
  // file — carries that depth on its continuation lines. Its closing line (`}`,
  // `]`, a heredoc marker) sits at the value's own base indentation, so strip
  // that much from every line before adding this depth, or each re-render
  // pushes the body two columns further right.
  const last = rest.at(-1) ?? "";
  const base = (/^[ \t]*/.exec(last)?.[0] ?? "").length;
  const pad = indent(depth);
  return [
    first,
    ...rest.map((line) => {
      if (!line.trim()) return "";
      const own = (/^[ \t]*/.exec(line)?.[0] ?? "").length;
      return `${pad}${line.slice(Math.min(base, own))}`;
    }),
  ].join("\n");
}

/** Render one block as formatted HCL. */
function renderBlock(block: HclBlock): string {
  return renderAt(block, 0);
}

/** Render a document: blocks separated by a blank line, trailing newline. */
export function renderDocument(blocks: HclBlock[]): string {
  return blocks.length === 0 ? "" : `${blocks.map((b) => renderBlock(b)).join("\n\n")}\n`;
}

/* ----------------------------------------------------------------- helpers -- */

/** Quote a plain string as an HCL literal. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render a map expression (`{ key = value }`) from entries, one per line, under
 * the same two rules `terraform fmt` applies to a block body: keys align only
 * within a run of single-line values, and a nested multi-line value is indented
 * one level deeper than the key that holds it. A map inside a map inside a module
 * call (`listeners = { http = { forward = { … } } }`) is ordinary in module-based
 * output, and without both rules every such plan failed `fmt -check`.
 */
export function mapExpression(entries: Array<{ key: string; value: string }>): string {
  if (entries.length === 0) return "{}";
  const widths = alignWidths(entries);
  const body = entries
    .map((e, i) => {
      const pad = " ".repeat((widths[i] ?? e.key.length) - e.key.length + 1);
      return `  ${e.key}${pad}= ${reindentValue(e.value, 1)}`;
    })
    .join("\n");
  return `{\n${body}\n}`;
}

/** Parse a rendered map expression back into its entries. */
/**
 * Add one entry to a block's map-valued attribute, creating the attribute when
 * this is the first entry to land there. An existing key is left alone, so a
 * second edge naming the same key does not overwrite the first.
 */
export function addMapEntry(
  host: HclBlock,
  attribute: string,
  entry: { key: string; value: string },
): void {
  const existing = host.attributes.find((a) => a.key === attribute);
  const entries = existing ? mapEntries(existing.value) : [];
  if (entries.some((e) => e.key === entry.key)) return;
  entries.push(entry);
  const value = mapExpression(entries);
  if (existing) existing.value = value;
  else host.attributes.push({ key: attribute, value });
}

export function mapEntries(expr: string | undefined): Array<{ key: string; value: string }> {
  if (!expr) return [];
  const trimmed = expr.trim();
  if (!trimmed.startsWith("{")) return [];
  const inner = trimmed.slice(1, -1);
  const body = parseBody(inner, 0, true);
  return body.attributes.map((a) => ({ key: a.key, value: a.value }));
}

/** A block builder that drops undefined attributes, so emit templates stay readable. */
export function block(
  type: string,
  labels: string[],
  attributes: Array<{ key: string; value: string | undefined } | null | undefined>,
  blocks: HclBlock[] = [],
): HclBlock {
  return {
    type,
    labels,
    attributes: attributes.filter(
      (a): a is { key: string; value: string } => !!a && a.value !== undefined,
    ),
    blocks,
  };
}
