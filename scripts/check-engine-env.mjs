// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The engine reads no environment: `packages/engine` is configured by what its caller
 * passes in (ports and arguments), never by `process.env`, so the same code runs in a
 * CLI, an Action and any other host without one of them silently changing what it emits.
 *
 *   node scripts/check-engine-env.mjs
 *
 * The import half of the boundary (no framework or service SDK, nothing from outside the package) is the
 * dependency-cruiser rules in .dependency-cruiser.cjs; this is the half it cannot see,
 * because `process.env` is a global rather than an import. Comments are ignored, so a
 * doc can still name the variable the host reads.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const engineDir = join(root, "packages", "engine");

const ENV_ACCESS = /\bprocess\s*(?:\.\s*env\b|\[\s*["'`]env["'`]\s*\])|\bimport\.meta\.env\b/;

/** Blank `//` and block comments, keeping newlines so line numbers stay true. */
function maskComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

const files = readdirSync(engineDir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && /\.(ts|mjs|js)$/.test(e.name))
  .map((e) => join(e.parentPath, e.name))
  .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === "dist"))
  .sort();

const errors = [];
for (const file of files) {
  maskComments(readFileSync(file, "utf8"))
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (ENV_ACCESS.test(line)) errors.push(`  ${relative(root, file)}:${i + 1}  ${line.trim().slice(0, 110)}`);
    });
}

if (errors.length) {
  console.error(`check-engine-env: ${errors.length} environment read${errors.length === 1 ? "" : "s"} inside packages/engine.\n`);
  console.error(errors.join("\n"));
  console.error("\nTake the value as an argument or a port from the caller and read the variable in the host.\n");
  process.exit(1);
}

console.log(`check-engine-env: no environment reads in packages/engine (${files.length} files).`);
