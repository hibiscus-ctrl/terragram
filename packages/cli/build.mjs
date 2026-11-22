// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bundle the CLI into one file, `dist/terragram.mjs`, with the engine, zod and dagre
 * inside it. Nothing is left external, so the file runs on a bare Node 24: no
 * node_modules, no registry. `@infraweaver-io/*` would be bundled like the rest, so a
 * public install can never need GitHub Packages; `tests/cli-bundle.test.ts` proves no
 * such import specifier survives.
 *
 * Not minified: the file is what a user is asked to trust, so it should be readable.
 */

import { chmodSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

const root = import.meta.dirname;
const outfile = join(root, "dist", "terragram.mjs");

rmSync(join(root, "dist"), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  // Bundled CommonJS (dagre) reaches for `require`, which an ES module lacks.
  banner: {
    js: [
      "#!/usr/bin/env node",
// REUSE-IgnoreStart
      "// SPDX-License-Identifier: AGPL-3.0-only",
// REUSE-IgnoreEnd
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

chmodSync(outfile, 0o755);
console.log(`terragram.mjs: ${(statSync(outfile).size / 1024).toFixed(0)} KiB`);
