// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pin refresh's pure parts: which registry version it accepts, and the text it
 * writes. The script itself needs the network; these do not. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// Plain .mjs ops script helpers, deliberately untyped like their peers in scripts/.
import { newestOnLine, renderModuleFile, renderProviderFile } from "../scripts/lib/pins.mjs";

// REUSE-IgnoreStart: the generated header, as text, not this file's licence.
const HEADER = "// Copyright 2026 Gabriel Ignat\n// SPDX-License-Identifier: AGPL-3.0-only\n\n";
// REUSE-IgnoreEnd

describe("newestOnLine", () => {
  it("picks the newest release on the pinned major", () => {
    assert.equal(newestOnLine("m", ["5.17.0", "5.18.2", "5.18.10", "6.0.0", "4.9.9"], "5.18.0"), "5.18.10");
  });

  it("keeps a 0.x pin on its minor", () => {
    assert.equal(newestOnLine("m", ["0.4.9", "0.5.1", "0.5.3", "0.6.0"], "0.5.0"), "0.5.3");
  });

  it("ignores pre-releases, build suffixes and a fourth segment", () => {
    assert.equal(
      newestOnLine("m", ["5.1.0", "5.9.0-beta.1", "5.9.0+build", "5.9.0.1", "5.9", "v5.9.0", " 5.9.0", "5.9.0\n"], "5.0.0"),
      "5.1.0",
    );
  });

  it("never lets a hostile registry string through", () => {
    const hostile = [
      '5.99.0"; throw new Error("x"); const y = "',
      "5.99.0\nexport const evil = 1",
      "5.99.0`${process.exit(1)}`",
      "5.99.99999999999999999999",
      "05.99.0",
      "5.99.0 ",
    ];
    assert.equal(newestOnLine("m", [...hostile, "5.2.0"], "5.0.0"), "5.2.0");
    assert.throws(() => newestOnLine("m", hostile, "5.0.0"), /no release on the 5\.0\.0 line/);
  });

  it("ignores entries that are not strings", () => {
    assert.equal(newestOnLine("m", [undefined, null, 5, "5.1.0"], "5.0.0"), "5.1.0");
  });
});

describe("generated source files", () => {
  const provider = [{ cloud: "aws", name: "aws", source: "hashicorp/aws", constraint: "~> 6.73" }];
  const modules = [{ key: "aws/vpc", source: "terraform-aws-modules/vpc/aws", version: "6.8.0" }];

  it("start with the per-file licence header", () => {
    assert.ok(renderProviderFile("2026-11-23", provider).startsWith(`${HEADER}/**`));
    assert.ok(renderModuleFile("2026-11-23", modules).startsWith(`${HEADER}/**`));
  });

  it("keep the committed files and the generator on the same header", async () => {
    for (const [name, render] of [
      ["provider-versions.ts", renderProviderFile],
      ["module-versions.ts", renderModuleFile],
    ] as const) {
      const committed = await readFile(new URL(`../packages/engine/src/${name}`, import.meta.url), "utf8");
      assert.ok(committed.startsWith(HEADER), `${name} lost its header`);
      assert.ok(render("2026-01-01", []).startsWith(HEADER));
    }
  });
});
