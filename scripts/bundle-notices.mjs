// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The licence notices of the third-party packages an esbuild bundle contains.
 *
 * zod, dagre and the rest are MIT: bundling their code into one file is allowed on the
 * condition that their copyright and permission notices travel with it. esbuild's
 * `legalComments` only keeps the `@license` and bang comments the sources already carry, and these
 * packages carry none, so the notices are read from each package's own licence file and
 * written at the end of the bundle. The result depends only on the packages bundled, so a
 * rebuild is byte-identical.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NODE_MODULES = /(^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/** The package directories, by name, that an esbuild metafile says went into the bundle. */
function bundledPackages(metafile, root) {
  const found = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = NODE_MODULES.exec(input);
    if (!match) continue;
    const name = match[2];
    const directory = join(root, input.slice(0, match.index + match[0].length));
    if (!found.has(name)) found.set(name, directory);
  }
  return found;
}

function licenceText(directory) {
  const file = readdirSync(directory).find((entry) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(entry));
  return file ? readFileSync(join(directory, file), "utf8").trim() : null;
}

/**
 * A block comment with each bundled package's name, version, SPDX licence and licence text,
 * sorted by name, or an empty string when nothing from node_modules was bundled. Throws when a
 * bundled package has no licence file, so a new dependency cannot ship without its notice.
 */
export function bundleNotices(metafile, root) {
  const packages = [...bundledPackages(metafile, root)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (packages.length === 0) return "";
  const sections = packages.map(([name, directory]) => {
    const manifest = join(directory, "package.json");
    const { version = "unknown", license = "see below" } = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, "utf8"))
      : {};
    const text = licenceText(directory);
    if (text === null) throw new Error(`${name} is bundled but has no licence file to carry`);
    // The text sits inside a comment: it must not be able to close it.
    return `${name}@${version} (${license})\n\n${text.replaceAll("*/", "* /")}`;
  });
  return `/*! Third-party licence notices\n\n${sections.join("\n\n----\n\n")}\n*/\n`;
}
