import { buildGraphModel, type GraphBox, type GraphLink } from "./graph-build.ts";
import type { InfraModel } from "./model.ts";

/**
 * Mermaid flowchart → model.
 *
 * A flowchart is the diagram format platform teams actually keep in their repos,
 * and it is text, so it can be read without a rendering engine or inference. Each
 * node's label is matched to a resource kind through the same registry keywords
 * the chat engine uses, so "Postgres database" lands on the same kind whether it
 * was typed in chat or drawn in a README. Each arrow becomes an edge the reviewer
 * owns; the honesty rules live in `graph-build.ts` and are shared with the
 * screenshot reader.
 *
 * Deliberately NOT a full Mermaid implementation: it reads `flowchart`/`graph`
 * declarations, node shapes, arrows, chains and `&` groups, and skips styling,
 * classes, click handlers and subgraph boundaries (their members are still read).
 */

export type InterchangeResult =
  | { ok: true; model: InfraModel; untranslated: string[] }
  | { ok: false; error: string };

const HEADER = /^(flowchart|graph)\b/i;

/** Lines that carry no nodes or edges and are safe to skip whole. */
const NOISE = /^(subgraph\b|end$|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|%%)/i;

/** A node with an optional shape: `id`, `id[Label]`, `id(Label)`, `id((Label))`,
 *  `id{Label}`, `id[(Label)]`, `id[[Label]]`, `id{{Label}}`, `id>Label]`. */
const NODE = /^([A-Za-z0-9_.-]+)\s*(?:(\[\[|\[\(|\(\(|\{\{|\[|\(|\{|>)\s*(.*?)\s*(\]\]|\)\]|\)\)|\}\}|\]|\)|\})\s*)?$/;

/** An arrow between two operands, with an optional label in either syntax. */
const ARROW = /\s*(?:<?-{2,3}>?|<?={2,3}>?|<?-\.+->?|-\.-)\s*(?:\|[^|]*\|\s*)?/;

/** `A -- label --> B` and `A == label ==> B`, which put the label between the strokes. */
const INLINE_LABEL = /\s*(?:--|==)\s*[^-=>]+?\s*(?:-->|==>|---|===)\s*/;

/** Whether pasted text is a flowchart rather than Terraform or prose. */
export function looksLikeMermaid(source: string): boolean {
  const first = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("%%"));
  return first !== undefined && HEADER.test(first);
}

function unquote(label: string): string {
  const trimmed = label.trim();
  const quoted = trimmed.match(/^"(.*)"$/);
  return (quoted ? quoted[1] : trimmed)?.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ") ?? "";
}

/**
 * Split a statement into its operands on arrows. Labelled arrows are stripped
 * first because their text can contain the characters the shape grammar keys on.
 */
function operands(statement: string): string[] {
  const parts = statement.replace(INLINE_LABEL, " --> ").split(ARROW);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function parseMermaid(source: string): InterchangeResult {
  if (!looksLikeMermaid(source)) {
    return {
      ok: false,
      error: "This does not look like a Mermaid flowchart. It should start with `flowchart` or `graph`.",
    };
  }

  // Every node and every arrow, in document order. A node declared only inside an
  // arrow (`A --> B[Database]`) is still a declaration.
  const labels = new Map<string, string>();
  const links: GraphLink[] = [];
  const order: string[] = [];

  const declare = (raw: string): string | null => {
    const match = raw.match(NODE);
    if (!match) return null;
    const [, id, , label] = match;
    if (!id) return null;
    if (!labels.has(id)) {
      labels.set(id, "");
      order.push(id);
    }
    const text = label ? unquote(label) : "";
    if (text && !labels.get(id)) labels.set(id, text);
    return id;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/%%.*$/, "").trim().replace(/;$/, "");
    if (!line || HEADER.test(line) || NOISE.test(line)) continue;

    const groups = operands(line).map((op) =>
      op
        .split("&")
        .map((part) => declare(part.trim()))
        .filter((id): id is string => id !== null),
    );
    for (let i = 0; i < groups.length - 1; i++) {
      for (const from of groups[i] ?? []) {
        for (const to of groups[i + 1] ?? []) links.push({ from, to });
      }
    }
  }

  if (order.length === 0) {
    return { ok: false, error: "No nodes were found in this flowchart." };
  }

  // A bare id like `db` is matched too — it is often the most telling word.
  const boxes: GraphBox[] = order.map((ref) => ({ ref, label: labels.get(ref) || ref }));
  return { ok: true, ...buildGraphModel(boxes, links) };
}
