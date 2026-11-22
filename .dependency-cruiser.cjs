// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Import gate: the specifier rule, no cycles, and the few edges that are security
 * properties rather than tidiness ones.
 *
 *   npm run check:imports
 *
 * Type-only imports count like any other: a type edge is still compile-time
 * coupling.
 *
 * Parser: TypeScript 7 ships no JS compiler API, which is what dependency-
 * cruiser's TS extractor needs, so it parses with swc (`@swc/core`). That is also
 * why every run ends in a `missing-typescript-transpiler` warning: `tsConfig` is
 * still read — by the resolver plugin, for the `@/` alias — just not by the
 * typescript package.
 *
 * `@/` specifiers that resolve to nothing are left to `tsc --noEmit`, whose
 * tsconfig includes every file under src/.
 */
const { readdirSync, readFileSync } = require("node:fs");

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sourceEntries = readdirSync("src", { recursive: true, withFileTypes: true });
const posix = (entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/");

/**
 * `@/` across directories, `./` within one, `../` never. A relative import must
 * resolve inside the importer's own directory. dependency-cruiser can compare
 * a dependency against its importer's folder only by substituting a captured
 * group into a regex, unescaped — and Next's `[id]` / `(app)` folders are regex
 * syntax — so this is one rule per source directory instead.
 */
const sourceDirs = ["src", ...sourceEntries.filter((e) => e.isDirectory()).map(posix)].sort();

const noParentRelative = sourceDirs.map((dir) => ({
  name: "no-parent-relative-import",
  comment:
    "A `../` import. Import across directories with `@/`; `./` within a directory is fine. " +
    "Plain node resolves the alias through scripts/alias-loader.mjs.",
  severity: "error",
  from: { path: `^${escapeRegex(dir)}/[^/]+$` },
  to: {
    dependencyTypes: ["local"],
    // The workspace package resolves to its real path, so `terragram-engine/…` reads as
    // local; it is imported by name, and engine-self-contained covers its own insides.
    pathNot: [`^${escapeRegex(dir)}/`, "^packages/engine/src/"],
  },
}));

/**
 * Files whose first statement is a directive — `"use client"` marks a Client
 * Component boundary. Read here because dependency-cruiser does not know about
 * directives.
 */
const sourceFiles = sourceEntries.filter((e) => e.isFile() && /\.tsx?$/.test(e.name)).map(posix);
const withDirective = (directive) =>
  sourceFiles.filter((file) =>
    new RegExp(`^\\s*(?:/\\*[\\s\\S]*?\\*/\\s*|//[^\\n]*\\n\\s*)*["']${directive}["']`).test(
      readFileSync(file, "utf8"),
    ),
  );
const clientFiles = withDirective("use client");
const serverOnlyFiles = sourceFiles.filter((file) =>
  /^import\s+["']server-only["']/m.test(readFileSync(file, "utf8")),
);

const pathsRegex = (files) => files.map((f) => `^${escapeRegex(f)}$`);

/** The clients that hold a secret: the Supabase service-role key and the Stripe secret key. */
const PRIVILEGED_CLIENT = "^src/libs/(supabase/supabase-admin|stripe/stripe-admin)\\.ts$";

/** The engine's own source, and the only npm packages it may import. */
const ENGINE = "^packages/engine/";
const ENGINE_ALLOWED_PACKAGES = ["zod", "dagre", "@infraweaver-io/attest"];

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    ...noParentRelative,
    {
      name: "no-circular",
      comment:
        "An import cycle. Module evaluation order inside a cycle is whichever file loads " +
        "first, so a binding can be read before it is initialised. Move the shared piece " +
        "into a module both sides import.",
      severity: "error",
      from: { path: "^(src|packages/engine/src)/" },
      to: { circular: true },
    },
    {
      name: "engine-no-app-imports",
      comment:
        "packages/engine imports something from the app (src/, via `@/` or a relative path). " +
        "The engine is a package other hosts embed — a CLI, an Action, another Next.js app — so " +
        "it can depend on nothing of this app. Take the value, or a port, from the caller " +
        "(see src/ports.ts) and bind it in src/features/workspace/.",
      severity: "error",
      from: { path: ENGINE },
      to: { path: "^src/" },
    },
    {
      name: "engine-no-framework-imports",
      comment:
        "packages/engine imports Next, React, Supabase or Stripe. The engine is pure " +
        "functions over plain data; anything that touches a framework or a service is the " +
        "host's, behind a port.",
      severity: "error",
      from: { path: ENGINE },
      to: {
        path: "(^|/)node_modules/(next|react|react-dom|@xyflow|@supabase|stripe|@stripe|server-only)(/|$)",
      },
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
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"],
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
      name: "components-no-privileged-client",
      comment:
        "A component imports a privileged client (the Supabase service-role client or " +
        "Stripe). Read through a features/* view or a server action, which is where the " +
        "membership and plan checks live.",
      severity: "error",
      from: { path: "^src/components/" },
      to: { path: PRIVILEGED_CLIENT },
    },
    {
      name: "stripe-admin-only-in-billing",
      comment:
        "`stripeAdmin` (and the secret key with it) imported outside features/billing. " +
        "`server-only` stops a Client Component, not a route or an action — and a direct " +
        "`stripeAdmin` call sidesteps the facade's ordering guards and idempotency keys. Add " +
        "the call to features/billing/stripe-billing.ts and import that.",
      severity: "error",
      from: { pathNot: "^src/features/billing/" },
      to: { path: "^src/libs/stripe/stripe-admin\\.ts$" },
    },
    {
      name: "client-no-server-only",
      comment:
        'A "use client" file imports a module marked `server-only` (a privileged client or ' +
        "the cookie-bound server client). It fails the build at best and ships the import " +
        "graph toward the browser at worst. Call a server action instead.",
      severity: "error",
      from: { path: pathsRegex(clientFiles) },
      to: { path: pathsRegex(serverOnlyFiles) },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
  },
};
