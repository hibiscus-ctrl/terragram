// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { explainModel } from "terragram-engine/explain";
import { assessFeasibility } from "terragram-engine/feasibility";
import { emitTerraform } from "terragram-engine/terraform";

import { type Io, UsageError } from "../io.ts";
import { DEFAULT_CLOUD, parseCloud, readModel } from "../model-file.ts";

const EXPLAIN_HELP = `Usage: terragram explain <model.json> [options]

Describe a model in plain English: what it builds, the path a request takes through it
and what still needs confirming. Deterministic, the same text the review gate shows.

Options:
  --cloud aws|azure  override the cloud the model file names (default: azure)
  --json             print the description with its cloud, region and omissions
  -h, --help         show this help
`;

export async function explain(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      cloud: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.out(EXPLAIN_HELP);
    return 0;
  }
  const [path, ...extra] = positionals;
  if (path === undefined || extra.length > 0) throw new UsageError("give exactly one model.json");

  const { model, cloud: documentCloud } = readModel(io, path);
  const cloud = parseCloud(values.cloud) ?? documentCloud ?? DEFAULT_CLOUD;
  const { region, regionLabel } = emitTerraform(model, cloud);
  const explanation = explainModel(model, cloud, regionLabel);

  if (values.json) {
    const { omitted } = assessFeasibility(model, cloud);
    io.out(`${JSON.stringify({ cloud, region, regionLabel, explanation, omitted }, null, 2)}\n`);
  } else {
    io.out(`${explanation}\n`);
  }
  return 0;
}
