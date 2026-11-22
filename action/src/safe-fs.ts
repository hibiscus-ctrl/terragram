// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { ActionError } from "./workflow.ts";

/**
 * File access for paths that come from a pull request.
 *
 * A pull request can commit a symlink in place of a model file, a Terraform file or
 * a directory. Followed, it would put files from the runner (credentials, other
 * checkouts) into a diff, a log or a PR comment, or send a write outside the
 * workspace. So every component between the workspace root and the target must be
 * a real directory or file, never a symlink, and writes use O_NOFOLLOW as well.
 */

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/** Refuse `target` if it leaves `root` or if any existing component under `root` is a symlink. */
export function assertNoSymlinks(root: string, target: string, label: string): void {
  const base = resolve(root);
  const full = resolve(target);
  if (!inside(base, full)) throw new ActionError(`${label} is outside the workspace`);
  const parts = relative(base, full).split(sep).filter((p) => p !== "");
  let current = base;
  for (const part of parts) {
    current = resolve(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      return; // the rest does not exist yet
    }
    if (stat.isSymbolicLink()) throw new ActionError(`${label}: refusing to follow the symlink ${relative(base, current)}`);
  }
}

/** Whether a regular file exists at `target` (after the symlink check). */
export function regularFileExists(root: string, target: string, label: string): boolean {
  assertNoSymlinks(root, target, label);
  if (!existsSync(target)) return false;
  if (!lstatSync(target).isFile()) throw new ActionError(`${label}: ${relative(resolve(root), target)} is not a regular file`);
  return true;
}

/** Read a regular file under `root`, refusing symlinks and anything else that is not a file. */
export function readRegularFile(root: string, target: string, label: string): string {
  if (!regularFileExists(root, target, label)) throw new ActionError(`${label}: ${relative(resolve(root), target)} does not exist`);
  return readFileSync(target, "utf8");
}

/** Write a file under `root` without following a symlink at any component. */
export function writeRegularFile(root: string, target: string, content: string, label: string): void {
  assertNoSymlinks(root, target, label);
  mkdirSync(dirname(target), { recursive: true });
  assertNoSymlinks(root, target, label);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
