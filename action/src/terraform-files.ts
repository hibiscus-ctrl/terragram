// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { lstatSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import type { TerraformFile } from "terragram-engine/terraform";

import { assertNoSymlinks, readRegularFile, regularFileExists, writeRegularFile } from "./safe-fs.ts";
import { unifiedDiff } from "./text-diff.ts";
import { ActionError } from "./workflow.ts";

/**
 * The generated Terraform against the Terraform in the repository.
 *
 * Only the files the Action generates are compared: a directory may hold a lock file,
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

/**
 * `root` is the workspace: every path from it to a file is checked for symlinks, since
 * a pull request can commit one in place of a Terraform file or the directory itself.
 */
export function compareFiles(root: string, dir: string, shownDir: string, generated: readonly TerraformFile[]): FileState[] {
  return generated.map((file) => {
    const target = pathUnder(dir, file.name);
    const shown = `${shownDir.replace(/\/+$/, "")}/${file.name}`;
    if (!regularFileExists(root, target, shown)) {
      return { name: file.name, status: "missing", diff: unifiedDiff("", file.content, "/dev/null", `b/${shown}`) };
    }
    const committed = readRegularFile(root, target, shown);
    const diff = unifiedDiff(committed, file.content, `a/${shown}`, `b/${shown}`);
    return { name: file.name, status: diff === "" ? "same" : "different", diff };
  });
}

/** Write the files that are not already in the directory as generated; returns the names written. */
export function writeFiles(root: string, dir: string, generated: readonly TerraformFile[], states: readonly FileState[]): string[] {
  const written: string[] = [];
  for (const file of generated) {
    if (states.find((s) => s.name === file.name)?.status === "same") continue;
    writeRegularFile(root, pathUnder(dir, file.name), file.content, file.name);
    written.push(file.name);
  }
  return written;
}

/** Replace a directory the Action owns (`_diagram/`) with the given files. */
export function replaceDirectory(root: string, dir: string, entries: readonly { name: string; content: string }[]): void {
  assertNoSymlinks(root, dir, "receipt directory");
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(dir);
  } catch {
    existing = null;
  }
  if (existing && !existing.isDirectory()) throw new ActionError(`${dir} exists and is not a directory`);
  rmSync(dir, { recursive: true, force: true });
  for (const entry of entries) {
    writeRegularFile(root, pathUnder(dir, entry.name), entry.content, entry.name);
  }
}
