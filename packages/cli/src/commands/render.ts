// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { modelToSvg } from "terragram-engine/diagram-svg";

import { CommandError, type Io, UsageError, writeText } from "../io.ts";
import { readModel } from "../model-file.ts";

const RENDER_HELP = `Usage: terragram render <model.json> [-o diagram.svg]

Draw a model as a standalone SVG, laid out the way the engine lays out a model.

Options:
  -o, --output <file>  where to write the SVG (default: standard output)
  -h, --help           show this help
`;

export async function render(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.out(RENDER_HELP);
    return 0;
  }
  const [path, ...extra] = positionals;
  if (path === undefined || extra.length > 0) throw new UsageError("give exactly one model.json");

  const { model } = readModel(io, path);
  const svg = modelToSvg(model);
  if (svg === "") throw new CommandError(`${path} has no components to draw`);

  if (values.output === undefined) {
    io.out(`${svg}\n`);
  } else {
    writeText(io, values.output, `${svg}\n`);
    io.out(`wrote ${values.output}\n`);
  }
  return 0;
}
