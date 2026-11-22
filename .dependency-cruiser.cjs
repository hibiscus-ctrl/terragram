// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Import gate: no cycles, and the edges that keep the engine, the CLI and the Action
 * what they claim to be.
 *
 *   npm run check:imports
 *
 * Type-only imports count like any other: a type edge is still compile-time
 * coupling.
 *
 * Parser: TypeScript 7 ships no JS compiler API, which is what dependency-
 * cruiser's TS extractor needs, so it parses with swc (`@swc/core`). That is also
 * why every run ends in a `missing-typescript-transpiler` warning.
 *
 * The engine is a workspace package, so a `terragram-engine/<subpath>` import resolves
 * to its real path under packages/engine/src and reads as a local dependency here.
 */

/** The engine's own source, and the only npm packages it may import. */
const ENGINE = "^packages/engine/";
const ENGINE_ALLOWED_PACKAGES = ["zod", "dagre"];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NPM = ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"];

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "An import cycle. Module evaluation order inside a cycle is whichever file loads " +
        "first, so a binding can be read before it is initialised. Move the shared piece " +
        "into a module both sides import.",
      severity: "error",
      from: { path: "^(packages/engine/src|packages/cli/src|action/src)/" },
      to: { circular: true },
    },
    {
      name: "engine-npm-allowlist",
      comment:
        "packages/engine imports an npm package it does not declare. Its runtime dependencies " +
        "(" + ENGINE_ALLOWED_PACKAGES.join(", ") + ") are the whole list: a new one is a " +
        "decision about what every host of the engine now installs, so add it here AND to " +
        "packages/engine/package.json together.",
      severity: "error",
      from: { path: ENGINE },
      to: {
        dependencyTypes: NPM,
        pathNot: ENGINE_ALLOWED_PACKAGES.map((name) => `(^|/)node_modules/${escapeRegex(name)}/`),
      },
    },
    {
      name: "engine-self-contained",
      comment:
        "A relative import in packages/engine that leaves packages/engine/src. Everything the " +
        "engine needs ships with it.",
      severity: "error",
      from: { path: "^packages/engine/src/" },
      to: { dependencyTypes: ["local"], pathNot: "^packages/engine/src/" },
    },
    {
      name: "cli-no-npm-imports",
      comment:
        "packages/cli imports an npm package. Its bundle has no runtime dependencies: the " +
        "engine (which dependency-cruiser sees as a local path, being a workspace) is " +
        "bundled in, and anything else would have to be bundled too. Take it from the engine " +
        "or from node:, or add it here deliberately.",
      severity: "error",
      from: { path: "^packages/cli/src/" },
      to: { dependencyTypes: NPM },
    },
    {
      name: "action-no-npm-imports",
      comment:
        "action/ imports an npm package. Its bundle has no runtime dependencies and the runner " +
        "does not run `npm ci`: the engine (a workspace, which dependency-cruiser sees as a " +
        "local path) is bundled in, and anything else would have to be bundled too. Use the " +
        "engine's exports or node:, or add the package here deliberately.",
      severity: "error",
      from: { path: "^action/src/" },
      to: { dependencyTypes: NPM },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
  },
};
