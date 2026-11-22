// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

/** Where a command's output goes. Injected so tests run commands in-process. */
export type Io = {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
};

export function processIo(): Io {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
  };
}

/** Bad arguments: the message is shown with a pointer to `--help`, and the exit code is 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** The command could not do what was asked (unreadable input, a failed check): exit 1. */
export class CommandError extends Error {
  override name = "CommandError";
}

export function readText(io: Io, path: string): string {
  try {
    return readFileSync(resolve(io.cwd, path), "utf8");
  } catch (cause) {
    throw new CommandError(`cannot read ${path}: ${(cause as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

export function isDirectory(io: Io, path: string): boolean {
  try {
    return statSync(resolve(io.cwd, path)).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(io: Io, path: string): boolean {
  try {
    return statSync(resolve(io.cwd, path)).isFile();
  } catch {
    return false;
  }
}

/** Names directly inside a directory, sorted so the order never depends on the filesystem. */
export function listDirectory(io: Io, path: string): string[] {
  return readdirSync(resolve(io.cwd, path)).sort();
}

/** Every file under a directory, as paths relative to it (forward slashes), sorted. */
export function listFiles(io: Io, path: string): string[] {
  const root = resolve(io.cwd, path);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll("\\", "/"))
    .sort();
}

/**
 * Write `content` at `name` under `dir`, creating directories. A name that would land
 * outside `dir` is refused: the engine names its own files, but a CLI that writes
 * what it is handed should not trust that.
 */
export function writeUnder(io: Io, dir: string, name: string, content: string): void {
  const clean = normalize(name);
  if (isAbsolute(clean) || clean.startsWith("..")) {
    throw new CommandError(`refusing to write outside the output directory: ${name}`);
  }
  const target = resolve(io.cwd, dir, clean);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function writeText(io: Io, path: string, content: string): void {
  const target = resolve(io.cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
