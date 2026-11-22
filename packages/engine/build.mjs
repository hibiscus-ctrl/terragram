// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bundle the engine's public entry points (the `exports` map) into `dist/`, as plain
 * ESM with shared code split into `dist/chunks/`. `tsc -p tsconfig.build.json` writes
 * the matching `.d.ts` beside them (the `build` script runs both).
 *
 * Only `zod` and `dagre` stay external: they are the engine's declared dependencies.
 * Anything else, `@infraweaver-io/*` included, is bundled, so installing the built
 * package never reaches for a registry that needs a token. The engine imports none of
 * them today; the rule is here so that one slipping in is bundled, not shipped as a
 * dependency, and `tests/cli-bundle.test.ts` fails if its specifier survives.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(join(root, "dist"), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: Object.values(pkg.exports),
  outbase: "src",
  outdir: "dist",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "es2024",
  external: Object.keys(pkg.dependencies ?? {}),
  banner: { js: "// SPDX-License-Identifier: AGPL-3.0-only" },
  logLevel: "info",
});
