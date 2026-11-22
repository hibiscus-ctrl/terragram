// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { parseTerraform } from "terragram-engine/parse";

import { CommandError, type Io, isDirectory, listDirectory, readText, UsageError, writeText } from "../io.ts";
import { modelDocument } from "../model-file.ts";

const PARSE_HELP = `Usage: terragram parse <dir | file.tf ...> [-o model.json] [options]

Read Terraform and write the diagram model it describes. A directory contributes its
*.tf files; resources the registry has no component for are listed on stderr, not
silently dropped.

Options:
  -o, --output <file>  where to write model.json (default: standard output)
  --json               with -o, print a machine-readable summary
  -h, --help           show this help
`;

/** The .tf files an argument names: itself, or a directory's own .tf files. */
function terraformFiles(io: Io, path: string): string[] {
  if (!isDirectory(io, path)) return [path];
  const files = listDirectory(io, path)
    .filter((name) => name.endsWith(".tf"))
    .map((name) => `${path.replace(/[\\/]+$/, "")}/${name}`);
  if (files.length === 0) throw new CommandError(`no .tf files in ${path}`);
  return files;
}

export async function parse(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.out(PARSE_HELP);
    return 0;
  }
  if (positionals.length === 0) throw new UsageError("give a directory or one or more .tf files");

  const source = positionals
    .flatMap((path) => terraformFiles(io, path))
    .map((path) => readText(io, path))
    .join("\n\n");
  const read = parseTerraform(source);
  if (!read.ok) throw new CommandError(read.error);

  const document = modelDocument(read.model, read.cloud);
  for (const item of read.untranslated) io.err(`not translated: ${item}\n`);

  if (values.output === undefined) {
    io.out(document);
    return 0;
  }
  writeText(io, values.output, document);
  if (values.json) {
    const summary = {
      cloud: read.cloud,
      output: values.output,
      nodes: read.model.nodes.length,
      edges: read.model.edges.length,
      untranslated: read.untranslated,
    };
    io.out(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    io.out(
      `wrote ${values.output} (${read.cloud}, ${read.model.nodes.length} components, ${read.model.edges.length} connections)\n`,
    );
  }
  return 0;
}
