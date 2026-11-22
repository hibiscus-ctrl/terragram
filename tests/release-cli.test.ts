// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The release gate for the CLI: the tag must name the package's version, and the notes
 * come from the changelog. Pure, so no runner or tag is needed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { changelogSection, checkTag, releaseNotes, versionOfTag } from "../scripts/release-cli.ts";

const root = join(import.meta.dirname, "..");

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something not yet released.

## [0.2.0] - 2026-12-01

### Added

- The install action.

### Fixed

- A bug.

## [0.1.0] - 2026-11-01

- First release.

[Unreleased]: https://example.invalid/compare/v0.2.0...HEAD
[0.2.0]: https://example.invalid/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.invalid/releases/v0.1.0
`;

describe("versionOfTag", () => {
  it("reads the version out of a cli tag, pre-releases included", () => {
    assert.equal(versionOfTag("cli-v1.2.3"), "1.2.3");
    assert.equal(versionOfTag("cli-v0.10.0-rc.1"), "0.10.0-rc.1");
  });

  it("rejects another prefix, a missing part, a leading zero and build metadata", () => {
    for (const tag of ["v1.2.3", "cli-1.2.3", "cli-v1.2", "cli-v01.2.3", "cli-v1.2.3+build", "cli-v", "cli-v1.2.3 "]) {
      assert.throws(() => versionOfTag(tag), /tag/, tag);
    }
  });
});

describe("checkTag", () => {
  it("passes when the tag and the package agree", () => {
    assert.equal(checkTag("cli-v0.1.0", "0.1.0"), "0.1.0");
  });

  it("fails, saying which two disagree, when they do not", () => {
    assert.throws(() => checkTag("cli-v0.2.0", "0.1.0"), /0\.2\.0.*0\.1\.0/);
    assert.throws(() => checkTag("cli-v0.1.0-rc.1", "0.1.0"), /0\.1\.0-rc\.1/);
  });

  it("fails on a package version that is not semantic", () => {
    assert.throws(() => checkTag("cli-v0.1.0", "latest"), /not a semantic version/);
  });
});

describe("changelogSection", () => {
  it("returns one version's section without its heading or the next one's", () => {
    const section = changelogSection(CHANGELOG, "0.2.0");
    assert.ok(section);
    assert.ok(section.startsWith("### Added"));
    assert.match(section, /The install action\./);
    assert.match(section, /A bug\./);
    assert.doesNotMatch(section, /First release|Something not yet released|^## /m);
  });

  it("drops the link definitions that close the file from the last section", () => {
    assert.equal(changelogSection(CHANGELOG, "0.1.0"), "- First release.");
  });

  it("is null for a version with no section, or an empty one", () => {
    assert.equal(changelogSection(CHANGELOG, "0.3.0"), null);
    assert.equal(changelogSection("## [0.3.0] - 2026-12-02\n\n## [0.2.0]\n\n- x\n", "0.3.0"), null);
  });

  it("does not take 0.1.0 for 0.1.0-rc.1 or 10.1.0", () => {
    assert.equal(changelogSection("## [0.1.0-rc.1]\n\n- rc\n", "0.1.0"), null);
    assert.equal(changelogSection("## [10.1.0]\n\n- ten\n", "0.1.0"), null);
  });

  it("reads a heading written without brackets", () => {
    assert.equal(changelogSection("## 0.4.0 - 2026-12-05\n\n- plain\n", "0.4.0"), "- plain");
  });
});

describe("releaseNotes", () => {
  it("falls back to a line that points at the changelog", () => {
    assert.match(releaseNotes(CHANGELOG, "0.3.0"), /Terragram CLI 0\.3\.0.*CHANGELOG\.md/);
    assert.match(releaseNotes(CHANGELOG, "0.1.0"), /First release/);
  });
});

describe("release-cli.ts", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, "scripts/release-cli.ts"), ...args], { encoding: "utf8" });
  const packageVersion = (JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as { version: string })
    .version;

  it("prints the package version, and accepts the matching tag", () => {
    assert.equal(run("version").stdout, `${packageVersion}\n`);
    assert.equal(run("version", `cli-v${packageVersion}`).stdout, `${packageVersion}\n`);
  });

  it("exits 1 with an error annotation on a tag that does not match", () => {
    const result = run("version", "cli-v99.0.0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^::error::.*99\.0\.0/);
  });
});
