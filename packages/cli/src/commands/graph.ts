// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import {
  DEFAULT_ASPECT,
  DEFAULT_GLUE,
  type GraphLayoutOptions,
  type GraphDocument,
  GraphDocumentError,
  MAX_ASPECT,
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

  const view = projectGraph(doc, {
    glue,
    delta: values.delta,
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
