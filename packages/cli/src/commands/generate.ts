// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from "node:util";

import { assessFeasibility } from "terragram-engine/feasibility";
import { parseMermaid } from "terragram-engine/interchange";
import { type Cloud, type InfraModel, resourceNodes } from "terragram-engine/model";
import { emitTerraform } from "terragram-engine/terraform";

import { composerFor } from "../inference.ts";
import { CommandError, type Io, readText, UsageError, writeUnder } from "../io.ts";
import { DEFAULT_CLOUD, modelDocument, parseCloud } from "../model-file.ts";

const GENERATE_HELP = `Usage: terragram generate (--prompt <text> | --mermaid <file>) -o <dir> [options]

Turn a brief or a Mermaid flowchart into Terraform. Writes main.tf, variables.tf,
outputs.tf (and anything a component adds beside them) plus model.json to <dir>.

Options:
  --prompt <text>     describe the infrastructure in plain English
  --mermaid <file>    read a Mermaid flowchart instead
  --cloud aws|azure   target cloud (default: the one the brief names, else azure)
  --tofu              emit for OpenTofu rather than Terraform
  -o, --output <dir>  directory to write to (required)
  --json              print a machine-readable summary
  -h, --help          show this help
`;

export async function generate(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      mermaid: { type: "string" },
      cloud: { type: "string" },
      tofu: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    io.out(GENERATE_HELP);
    return 0;
  }
  if ((values.prompt === undefined) === (values.mermaid === undefined)) {
    throw new UsageError("give exactly one of --prompt <text> or --mermaid <file>");
  }
  if (values.output === undefined) throw new UsageError("-o <dir> is required");
  const chosenCloud = parseCloud(values.cloud);

  let model: InfraModel;
  let detectedCloud: Cloud | undefined;
  const notes: string[] = [];
  if (values.prompt !== undefined) {
    const composed = await composerFor().compose(values.prompt);
    model = composed.model;
    detectedCloud = composed.cloud;
  } else {
    const read = parseMermaid(readText(io, values.mermaid as string));
    if (!read.ok) throw new CommandError(read.error);
    model = read.model;
    notes.push(...read.untranslated.map((item) => `not translated: ${item}`));
  }
  if (resourceNodes(model).length === 0) {
    throw new CommandError("nothing to build: no components were recognised in the input");
  }

  const cloud = chosenCloud ?? detectedCloud ?? DEFAULT_CLOUD;
  const tool = values.tofu ? "opentofu" : "terraform";
  const terraform = emitTerraform(model, cloud, tool);
  const { omitted } = assessFeasibility(model, cloud);
  for (const label of omitted) notes.push(`left out, not buildable on ${cloud}: ${label}`);

  const files = [...terraform.files.map((f) => f.name), "model.json"];
  for (const file of terraform.files) writeUnder(io, values.output, file.name, file.content);
  writeUnder(io, values.output, "model.json", modelDocument(model, cloud));

  if (values.json) {
    io.out(
      `${JSON.stringify({ cloud, tool, region: terraform.region, output: values.output, files, omitted, notes }, null, 2)}\n`,
    );
  } else {
    for (const note of notes) io.err(`${note}\n`);
    io.out(`wrote ${files.length} files to ${values.output} (${cloud}, ${tool}, ${terraform.regionLabel})\n`);
  }
  return 0;
}
