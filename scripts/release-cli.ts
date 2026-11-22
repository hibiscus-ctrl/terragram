// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What `release-cli.yml` needs to know before it publishes the CLI: that the tag being
 * released names the version in `packages/cli/package.json`, and what to say in the
 * release notes.
 *
 *   node scripts/release-cli.ts version [<tag>]       prints the version; with a tag, fails unless they agree
 *   node scripts/release-cli.ts notes <version> <out> writes the CHANGELOG section for <version> to <out>
 *
 * Pure functions below, so `tests/release-cli.test.ts` pins them without a runner.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TAG_PREFIX = "cli-v";
// A plain semantic version, with an optional pre-release (1.2.3-rc.1); no build metadata.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** The version a release tag names (`cli-v1.2.3` is `1.2.3`), or an error saying what is wrong with it. */
export function versionOfTag(tag: string): string {
  if (!tag.startsWith(TAG_PREFIX)) {
    throw new Error(`the tag "${tag}" does not start with ${TAG_PREFIX}`);
  }
  const version = tag.slice(TAG_PREFIX.length);
  if (!SEMVER.test(version)) {
    throw new Error(`the tag "${tag}" is not ${TAG_PREFIX}<major>.<minor>.<patch>[-prerelease]`);
  }
  return version;
}

/** Fails unless the tag's version is exactly the package's; returns that version. */
export function checkTag(tag: string, packageVersion: string): string {
  const version = versionOfTag(tag);
  if (!SEMVER.test(packageVersion)) {
    throw new Error(`packages/cli/package.json has the version "${packageVersion}", which is not a semantic version`);
  }
  if (version !== packageVersion) {
    throw new Error(
      `the tag "${tag}" is version ${version} but packages/cli/package.json is ${packageVersion}: bump it and the changelog first`,
    );
  }
  return version;
}

/**
 * The body of the `## [<version>]` section of a Keep a Changelog file, trimmed, without
 * its heading; `null` when there is no such section or it is empty. The section ends at
 * the next `## ` heading or at the link definitions that close the file.
 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const heading = (line: string) => /^## /.test(line);
  const start = lines.findIndex((line) => heading(line) && line.slice(3).replace(/^\[|\]/g, "").split(/\s/)[0] === version);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && heading(line));
  if (end === -1) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    // Link reference definitions at the end of the file belong to no section.
    .replace(/(\n\[[^\]]+\]: \S+)+\s*$/, "")
    .trim();
  return body === "" ? null : body;
}

/** The release notes: the changelog section when there is one, else a line saying where to look. */
export function releaseNotes(changelog: string, version: string): string {
  return changelogSection(changelog, version) ?? `Terragram CLI ${version}. See CHANGELOG.md for the changes.`;
}

function main(argv: string[]): void {
  const root = join(import.meta.dirname, "..");
  const [command, ...rest] = argv;
  if (command === "version") {
    const pkg = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as { version: string };
    const tag = rest[0];
    process.stdout.write(`${tag ? checkTag(tag, pkg.version) : pkg.version}\n`);
    return;
  }
  if (command === "notes" && rest.length === 2) {
    const [version, out] = rest as [string, string];
    writeFileSync(out, `${releaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version)}\n`);
    return;
  }
  throw new Error("usage: release-cli.ts version [<tag>] | notes <version> <out>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
