// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { composeFromPrompt } from "terragram-engine/engine";
import { emitTerraform } from "terragram-engine/terraform";

import { BRIEFS } from "../scripts/emit-briefs.ts";

/**
 * What a user gets when they install the built packages rather than run from the
 * repo. The CLI is one file that must run on a bare Node, and neither build may leave
 * an import of the restricted `@infraweaver-io/*` packages behind, because that is the
 * one thing a public install cannot resolve.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const cliBundle = join(root, "packages/cli/dist/terragram.mjs");
const engineDist = join(root, "packages/engine/dist");

const scratch = mkdtempSync(join(tmpdir(), "terragram-bundle-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Every module specifier a JS or .d.ts file imports, whatever the form. */
function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    // `import ... from "x"` and `export ... from "x"`, over as many lines as the names take.
    /^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) found.add(m[1] ?? "");
  return [...found];
}

const isBuiltin = (specifier: string) =>
  specifier.startsWith("node:") || builtinModules.includes(specifier);

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(extension))
    .map((e) => join(e.parentPath, e.name));
}

before(() => {
  const built = spawnSync("npm", ["run", "--silent", "build:packages"], { cwd: root, encoding: "utf8" });
  assert.equal(built.status, 0, `build:packages failed\n${built.stdout}${built.stderr}`);
});

describe("the CLI bundle", () => {
  it("is a single executable file with a shebang", () => {
    assert.match(readFileSync(cliBundle, "utf8"), /^#!\/usr\/bin\/env node\n/);
    assert.ok(statSync(cliBundle).mode & 0o100, "the bin file must be executable");
  });

  it("imports nothing but Node's own modules: no @infraweaver-io, no zod, no node_modules", () => {
    const specifiers = importSpecifiers(readFileSync(cliBundle, "utf8"));
    assert.ok(specifiers.length > 0, "the scan found no imports at all, so it proves nothing");
    assert.deepEqual(
      specifiers.filter((s) => s.includes("@infraweaver-io")),
      [],
    );
    assert.deepEqual(
      specifiers.filter((s) => !isBuiltin(s)),
      [],
      "every bare import must be a Node builtin",
    );
  });

  it("runs --version from a directory with no node_modules", () => {
    const bare = mkdtempSync(join(scratch, "bare-"));
    const copy = join(bare, "terragram.mjs");
    copyFileSync(cliBundle, copy);
    const version = (JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as { version: string })
      .version;

    const result = spawnSync(process.execPath, [copy, "--version"], {
      cwd: bare,
      encoding: "utf8",
      // A clean environment: nothing that could point Node back at the repo's modules.
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  });

  it("generates the same Terraform from a bare directory as the engine does", () => {
    const bare = mkdtempSync(join(scratch, "bare-"));
    copyFileSync(cliBundle, join(bare, "terragram.mjs"));
    const brief = BRIEFS[1] ?? "";
    const result = spawnSync(
      process.execPath,
      ["terragram.mjs", "generate", "--prompt", brief, "--cloud", "aws", "-o", "out"],
      { cwd: bare, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const file of emitTerraform(composeFromPrompt(brief).model, "aws").files) {
      assert.equal(readFileSync(join(bare, "out", file.name), "utf8"), file.content);
    }
  });

  it("exits 2 on a usage error and 1 on a failed command, as built", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cliBundle, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.equal(run("frobnicate").status, 2);
    assert.equal(run("explain", join(scratch, "missing.json")).status, 1);
  });
});

describe("the engine library build", () => {
  it("writes ESM and declarations for every public entry point", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages/engine/package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    for (const entry of Object.keys(pkg.exports)) {
      const name = entry.slice(2);
      assert.ok(statSync(join(engineDist, `${name}.js`)).isFile(), `${name}.js`);
      assert.ok(statSync(join(engineDist, `${name}.d.ts`)).isFile(), `${name}.d.ts`);
    }
  });

  it("imports only zod, dagre and its own files: nothing restricted, no .ts specifiers in declarations", () => {
    const files = [...filesUnder(engineDist, ".js"), ...filesUnder(engineDist, ".d.ts")];
    assert.ok(files.length > 50);
    const allowed = new Set(["zod", "dagre"]);
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        assert.ok(!specifier.includes("@infraweaver-io"), `${file} imports ${specifier}`);
        if (specifier.startsWith(".")) {
          assert.ok(specifier.endsWith(".js"), `${file} imports ${specifier}, which a consumer cannot resolve`);
        } else {
          assert.ok(isBuiltin(specifier) || allowed.has(specifier), `${file} imports ${specifier}`);
        }
      }
    }
  });

  it("emits the same Terraform as the source it was built from", async () => {
    const built = (await import(join(engineDist, "engine.js"))) as typeof import("terragram-engine/engine");
    const builtTerraform = (await import(join(engineDist, "terraform.js"))) as typeof import("terragram-engine/terraform");
    for (const brief of BRIEFS) {
      for (const cloud of ["aws", "azure"] as const) {
        assert.deepEqual(
          builtTerraform.emitTerraform(built.composeFromPrompt(brief).model, cloud),
          emitTerraform(composeFromPrompt(brief).model, cloud),
        );
      }
    }
  });
});

