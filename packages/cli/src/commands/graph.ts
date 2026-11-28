// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import {
  DEFAULT_ASPECT,
  DEFAULT_GLUE,
  type GraphLayoutOptions,
  type GraphDocument,
  GRAPH_LEVELS,
  GraphDocumentError,
  GraphViewError,
  MAX_ASPECT,
  MAX_FOCUS_HOPS,
  MIN_ASPECT,
  parseFindings,
  parseGraphDocument,
  projectGraph,
  renderGraphDrawio,
  renderGraphMermaid,
  renderGraphSvg,
} from "terragram-engine/graph";

import { CommandError, type Io, readText, UsageError, writeText } from "../io.ts";

const GRAPH_HELP = `Usage: terragram graph <graph.json> [options]

Draw an imported estate from infraharvest's graph/v1 document (infraharvest export
--schema graph): scopes, environments and module calls as boxes, the references between
resources as arrows. The same document gives the same bytes.

Options:
  --base <graph.json>      an earlier graph: mark what was added, removed or changed
  --delta                  with --base: draw only what changed and one reference of context
  --findings <file>        findings to lay over the graph: infraharvest's ocsf-findings export,
                           or JSON with a "findings" list (severity, title or rule_id, and
                           type + id, a Terraform address that the graph keeps, or account,
                           to place each one)
  -f, --format <format>    svg (default), drawio (a diagrams.net
                           file), mermaid (a flowchart) or json (the view model)
  --title <text>           a title for the picture
  --aspect <ratio>         the width over the height to pack the picture toward (svg and drawio;
                           default ${DEFAULT_ASPECT}, from ${MIN_ASPECT} to ${MAX_ASPECT})
  --level <level>          how much to draw: detailed (default; a card per resource), services (the
                           resources of one service in a box as one card, "Lambda x12") or overview
                           (each box as one card, its resources counted by category); a line between
                           cards carries the number of references it stands for
  --focus <node>           draw only this node and what is within --hops references of it, with the
                           boxes around them; a node id from \`--format json\` run with the same --level,
                           --base and --delta (n12; a0 for a card of several resources), or a label (a
                           resource's short ID) that only one node has
  --hops <n>               with --focus: how many references away to go, 1 to ${MAX_FOCUS_HOPS} (default 1)
  --show-glue              draw the resources that are hidden as glue (attachments,
                           associations, random_*, null_resource, ...)
  --hide <glob>            also hide resource types matching this glob, e.g. aws_cloudwatch_* (repeatable)
  --keep <type>            never hide this resource type (repeatable)
  -o, --output <file>      where to write it (default: standard output)
  -h, --help               show this help

Exit status: 0 success, 1 the command failed, 2 bad arguments.
`;

const FORMATS = ["svg", "drawio", "mermaid", "json"] as const;

function readGraph(io: Io, path: string): GraphDocument {
  try {
    return parseGraphDocument(readText(io, path));
  } catch (error) {
    if (error instanceof GraphDocumentError) throw new CommandError(`${path}: ${error.message}`);
    throw error;
  }
}

/** The picture, with a focus that the graph has no node for said as a mistake of the arguments. */
function project(doc: GraphDocument, options: Parameters<typeof projectGraph>[1]) {
  try {
    return projectGraph(doc, options);
  } catch (error) {
    if (error instanceof GraphViewError) throw new UsageError(error.message);
    throw error;
  }
}

export async function graph(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      delta: { type: "boolean", default: false },
      findings: { type: "string" },
      format: { type: "string", short: "f", default: "svg" },
      title: { type: "string" },
      aspect: { type: "string" },
      level: { type: "string" },
      focus: { type: "string" },
      hops: { type: "string" },
      "show-glue": { type: "boolean", default: false },
      hide: { type: "string", multiple: true },
      keep: { type: "string", multiple: true },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.out(GRAPH_HELP);
    return 0;
  }
  const [path, ...extra] = positionals;
  if (path === undefined || extra.length > 0) throw new UsageError("give exactly one graph.json");
  const format = FORMATS.find((f) => f === values.format);
  if (format === undefined) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}`);
  let layout: GraphLayoutOptions = {};
  if (values.aspect !== undefined) {
    const aspect = values.aspect.trim() === "" ? Number.NaN : Number(values.aspect);
    if (!(aspect >= MIN_ASPECT && aspect <= MAX_ASPECT)) throw new UsageError(`--aspect must be a number from ${MIN_ASPECT} to ${MAX_ASPECT}`);
    layout = { aspect };
  }
  if (values.delta && values.base === undefined) throw new UsageError("--delta needs --base");
  const level = values.level === undefined ? "detailed" : GRAPH_LEVELS.find((l) => l === values.level);
  if (level === undefined) throw new UsageError(`--level must be one of ${GRAPH_LEVELS.join(", ")}`);
  if (values.focus === undefined && values.hops !== undefined) throw new UsageError("--hops needs --focus");
  if (values.focus === "") throw new UsageError("--focus needs a node");
  const hops = values.hops === undefined ? 1 : /^[0-9]+$/.test(values.hops) ? Number(values.hops) : Number.NaN;
  if (!(hops >= 1 && hops <= MAX_FOCUS_HOPS)) throw new UsageError(`--hops must be a whole number from 1 to ${MAX_FOCUS_HOPS}`);

  const hide = values.hide ?? [];
  const glue = values["show-glue"]
    ? false
    : { ...DEFAULT_GLUE, patterns: [...DEFAULT_GLUE.patterns, ...hide], keep: [...DEFAULT_GLUE.keep, ...(values.keep ?? [])] };

  const doc = readGraph(io, path);
  const base = values.base === undefined ? undefined : readGraph(io, values.base);
  let findings: ReturnType<typeof parseFindings> | undefined;
  if (values.findings !== undefined) {
    try {
      findings = parseFindings(readText(io, values.findings));
    } catch (error) {
      if (error instanceof GraphDocumentError) throw new CommandError(`${values.findings}: ${error.message}`);
      throw error;
    }
  }

  const view = project(doc, {
    glue,
    delta: values.delta,
    level,
    ...(values.focus !== undefined && { focus: { node: values.focus, hops } }),
    ...(base && { base }),
    ...(findings && { findings }),
    ...(values.title !== undefined && { title: values.title }),
  });
  const body =
    format === "svg"
      ? `${renderGraphSvg(view, layout)}\n`
      : format === "drawio"
        ? renderGraphDrawio(view, layout)
        : format === "mermaid"
          ? renderGraphMermaid(view)
          : `${JSON.stringify(view, null, 2)}\n`;

  if (values.output === undefined) {
    io.out(body);
  } else {
    writeText(io, values.output, body);
    io.out(`wrote ${values.output}\n`);
  }
  return 0;
}
