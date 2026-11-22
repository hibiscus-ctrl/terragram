// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import pkg from "../package.json" with { type: "json" };
import { explain } from "./commands/explain.ts";
import { generate } from "./commands/generate.ts";
import { parse } from "./commands/parse.ts";
import { render } from "./commands/render.ts";
import { verify } from "./commands/verify.ts";
import { CommandError, type Io, processIo, UsageError } from "./io.ts";

const VERSION: string = pkg.version;

const HELP = `terragram ${VERSION}: a brief or a diagram to reviewed Terraform, and back.

Usage: terragram <command> [options]

Commands:
  generate  a brief (--prompt) or Mermaid flowchart (--mermaid) to Terraform files + model.json
  parse     Terraform (a directory or .tf files) to model.json
  render    model.json to an SVG diagram
  explain   model.json to a plain-English description
  verify    check an evidence receipt offline, optionally with its detached signature

Run \`terragram <command> --help\` for a command's options.
Everything here is deterministic and runs offline; no model is called.

Options:
  --version  print the version
  --help     print this help

Exit status: 0 success, 1 the command failed, 2 bad arguments.
`;

const COMMANDS: Record<string, (argv: string[], io: Io) => Promise<number>> = {
  generate,
  parse,
  render,
  explain,
  verify,
};

/** Run the CLI over `argv` (without the node and script paths) and return the exit status. */
export async function run(argv: string[], io: Io = processIo()): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      (command === undefined ? io.err : io.out)(HELP);
      return command === undefined ? 2 : 0;
    }
    if (command === "--version" || command === "-v") {
      io.out(`${VERSION}\n`);
      return 0;
    }
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!handler) throw new UsageError(`unknown command "${command}"`);
    return await handler(rest, io);
  } catch (error) {
    if (error instanceof CommandError) {
      io.err(`terragram: ${error.message}\n`);
      return 1;
    }
    // parseArgs reports an unknown flag or a missing value with a coded TypeError.
    const code = (error as { code?: unknown }).code;
    if (error instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      io.err(`terragram: ${(error as Error).message}\nRun \`terragram ${command ?? ""} --help\` for usage.\n`);
      return 2;
    }
    io.err(`terragram: unexpected error: ${(error as Error).message ?? String(error)}\n`);
    return 1;
  }
}
