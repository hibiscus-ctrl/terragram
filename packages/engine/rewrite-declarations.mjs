// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Point the emitted declarations at the bundle. `tsc` keeps the `./x.ts` specifiers the
 * source is written with; a consumer resolves `./x.js`, which sits beside each `.d.ts`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "dist");

for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
  const path = join(entry.parentPath, entry.name);
  const text = readFileSync(path, "utf8");
  const next = text.replace(/(from |import\()"(\.{1,2}\/[^"]+)\.ts"/g, '$1"$2.js"');
  if (next !== text) writeFileSync(path, next);
}
