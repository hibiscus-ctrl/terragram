// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { TerraformFile } from "terragram-engine/terraform";

import { unifiedDiff } from "./text-diff.ts";
import { ActionError } from "./workflow.ts";

/**
 * The generated Terraform against the Terraform in the repository.
 *
 * Only the files Terragram generates are compared: a directory may hold a lock file,
 * tfvars or modules of its own, and none of that is the Action's business.
 */

export type FileState = {
  name: string;
  /** `missing`: not in the directory at all. `different`: there, with other content. */
  status: "same" | "missing" | "different";
  /** Unified diff from the committed file to the regenerated one; "" when the same. */
  diff: string;
};

/** A generated file's name, joined under `dir`; a name that would leave `dir` is refused. */
function pathUnder(dir: string, name: string): string {
  const target = resolve(dir, name);
  if (!target.startsWith(`${resolve(dir)}/`) && !target.startsWith(`${resolve(dir)}\\`)) {
    throw new ActionError(`refusing to write outside ${dir}: ${name}`);
  }
  return target;
}

export function compareFiles(dir: string, shownDir: string, generated: readonly TerraformFile[]): FileState[] {
  return generated.map((file) => {
    const target = pathUnder(dir, file.name);
    const shown = `${shownDir.replace(/\/+$/, "")}/${file.name}`;
    if (!existsSync(target)) {
      return { name: file.name, status: "missing", diff: unifiedDiff("", file.content, "/dev/null", `b/${shown}`) };
    }
    const committed = readFileSync(target, "utf8");
    const diff = unifiedDiff(committed, file.content, `a/${shown}`, `b/${shown}`);
    return { name: file.name, status: diff === "" ? "same" : "different", diff };
  });
}

/** Write the files that are not already in the directory as generated; returns the names written. */
export function writeFiles(dir: string, generated: readonly TerraformFile[], states: readonly FileState[]): string[] {
  const written: string[] = [];
  for (const file of generated) {
    if (states.find((s) => s.name === file.name)?.status === "same") continue;
    const target = pathUnder(dir, file.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    written.push(file.name);
  }
  return written;
}

/** Replace a directory the Action owns (`_terragram/`) with the given files. */
export function replaceDirectory(dir: string, entries: readonly { name: string; content: string }[]): void {
  rmSync(dir, { recursive: true, force: true });
  for (const entry of entries) {
    const target = pathUnder(dir, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
  }
}
