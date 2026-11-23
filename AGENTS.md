# terragram

TypeScript monorepo: the Terragram generation engine (`packages/engine`), a command line over it
(`packages/cli`), a GitHub Action (`action/`) and the JSON Schemas (`schemas/`). Tests run with
`node --test`, Biome lints (its formatter is off). Terragram turns a diagram or brief into reviewed
Terraform: the model proposes component *kinds*, and the HCL comes from the deterministic registry
in `packages/engine/src/kinds.ts`. Node **24** is the floor (`engines`, `.nvmrc`, CI all agree). npm,
not pnpm: use `npm ci`, and a lockfile mismatch is a real failure to fix in the commit.

## Gates

```bash
npm run typecheck:all && npm test && npm run check:imports && npm run knip && npm run lint:ci && npm run lint:ox
```

CI runs the same set, plus:

- `test:coverage`: the unit suite under c8 `--all` with floors (in `package.json`) for the engine and the CLI.
  The Action's source is not in the floor because its tests run the built bundle; the CLI's `main.ts` is a
  six-line entry point.
- The **Packages** job: `schemas:check`, `build:packages`, then the schema, CLI and bundle tests with Terraform installed.
- The **action-dist** job: `build:action`, then `git diff --exit-code -- action/dist`. `action-selftest.yml` runs the Action on the fixture for changes under `action/` or `packages/`.
- The **Generated Terraform** job: `validate:emit` runs `fmt`, `validate`, tflint, trivy and
  checkov over every brief and template, and `check:modules` checks every pinned module call
  against its published interface.
- `lint:lockfile`, `reuse lint`, pinact (SHA-pinned actions) and zizmor (workflow lint).
- The diff-scoped security gates in `security-scan.yml`: Semgrep, Trivy secrets and the
  dep-CVE base-vs-head check.

## The engine: `packages/engine`

`terragram-engine` (an npm workspace, private for now) is the generation engine and nothing
else: the model and kind registry, the Terraform/OpenTofu emitter, the HCL parser, importers,
verifier, explainer, receipts, layout and the SVG export. It is imported by subpath
(`terragram-engine/kinds`, `terragram-engine/terraform`, …; the `exports` map is its public
surface) and ships TypeScript source. The CLI and the Action import it in-process.

- **Nothing host-shaped goes in.** No framework, no service SDK, no `process.env`. `check:imports`
  enforces it: dependency-cruiser rules (`engine-*` in `.dependency-cruiser.cjs`) plus
  `scripts/check-engine-env.mjs`. A new npm dependency of the engine goes in its `package.json` and
  the `engine-npm-allowlist` rule together.
- **Anything that needs the outside world is a port** (`src/ports.ts`): `ModelClient` (send a
  Messages request, get the forced tool call's input back), `Signer` (sign bytes, key id,
  public key) and `Logger`. The engine holds the decisions (the prompt, reading the answer,
  the cap-reached fallback, the receipt's contents); the host binds the port. The managed-inference
  modules (`managed-compose`, `vision`, `translate`, `managed-models`) have no host in this repo yet
  and are exercised by tests with a fake `ModelClient`.
- Tests live in `tests/` and import the package by name, so one runner covers every package.
  `tests/helpers/receipt.ts` binds a test `Signer` the way a host would. The engine has its own
  `tsc` project (`typecheck:engine`: Node only, no DOM).

## The CLI and the schemas: `packages/cli`, `schemas/`

`terragram` (`packages/cli`, private for now) is a host of the engine: `generate`, `parse`,
`render`, `explain` and `verify`, deterministic and offline.

- **Public exports only.** Import `terragram-engine/<subpath>` and Node, nothing else: no npm
  package (`cli-*` rules in `.dependency-cruiser.cjs`, and `tests/cli.test.ts` checks every
  specifier against the engine's `exports` map). If it needs something the engine does not export,
  export it from the engine.
- **Output must equal the engine's.** `tests/cli.test.ts` runs the commands over `scripts/emit-briefs.ts`
  (the emit gate's briefs) and the templates, and compares byte for byte with `emitTerraform`,
  `modelToSvg` and `explainModel`; `terraform fmt -check` runs on the output when Terraform is
  installed. A CLI-only tweak to generated Terraform is a bug.
- **`verify` trusts only a key from outside the bundle.** `--key` or `--trust` (key id to PEM); never
  `signing-key.pem` from the bundle directory, and an unsigned receipt does not verify
  (`--allow-unsigned` is hashes only and says UNSIGNED). The receipt's carried key must equal the trusted
  one. Keep those tests (`terragram verify` in `tests/cli.test.ts`) when touching it.
- **Inference seam.** `--prompt` goes through a `Composer` (`src/inference.ts`); the only one is the
  deterministic engine. Managed inference would be a second `Composer` over the engine's `ModelClient`
  port, chosen in `composerFor`. Do not call a model from a command directly.
- **Builds.** `npm run build:packages` bundles `packages/cli/dist/terragram.mjs` (esbuild: engine, zod
  and dagre inside, no runtime dependencies) and `packages/engine/dist` (ESM + `.d.ts`; only zod
  and dagre stay external). `@infraweaver-io/*` stay in source but are bundled, never left as an
  import, so a public install never reaches GitHub Packages; `tests/cli-bundle.test.ts` fails if a
  specifier survives, and runs the bundle from a directory with no `node_modules`. The engine's
  `exports` still point at `src/`; they flip to `dist/` when it is published, which this repo does not
  do yet: both packages are `"private": true`, with no npm publish. The CLI bundle is published as a GitHub
  release asset by `release-cli.yml` (below).
- **Schemas.** `schemas/*.schema.json` (Apache-2.0, REUSE-annotated) are generated by
  `npm run schemas:gen` from `modelDocumentSchema` (`model.ts`) and `evidenceReceiptSchema`
  (`receipt-schema.ts`); CI runs `schemas:check`. Change a document's shape in the zod schema, regenerate
  and commit the schema. `tests/schemas.test.ts` validates real documents with Ajv and ties the
  receipt schema to the `EvidenceReceipt` type. Ids are `diagram.model/v1` and `diagram.receipt/v2`
  (dots, as the receipt always has); `$id` URLs sit under the repository for now and will move with
  the name. `schemas/diagram-bundle-v1.schema.json` is the exception: it describes the document the Action uploads
  (`action/src/upload.ts`), which the Action owns rather than the engine, so it is written by hand, and
  `tests/action-upload.test.ts` validates the document the Action really sends against it; change both together.
  `terragram verify` still accepts receipts carrying `terragram.receipt/v1` and `/v2`
  (`VERIFIABLE_RECEIPT_SCHEMAS`); the model reader accepts only `diagram.model/v1`.
- **Codename versus wire names.** `terragram` is the repository, package and command name for now.
  Anything that lands in a document, generated code or a customer's repository says `diagram`:
  the schema ids, the `ManagedBy = "diagram"` tag, the Action's `diagram.json`, `_diagram/` and
  comment marker. Do not write the codename into any of those.

## Releasing the CLI: `.github/workflows/release-cli.yml`, `action/install-cli`

The bundle `packages/cli/dist/terragram.mjs` is released as `terragram-<version>.mjs` plus `SHA256SUMS` on a GitHub
release, with build provenance attested; other repositories' workflows download a pinned version with
`action/install-cli` (version + sha256 pinned by the caller, attestation verified with `gh`).

To cut a release:

1. Bump `version` in `packages/cli/package.json` (`--version` and the help read it) and, in `CHANGELOG.md`, rename
   `## [Unreleased]` to `## [X.Y.Z] - date`, adding a new empty `Unreleased`. That section becomes the release notes.
2. Merge it, then from `main`: `git tag cli-vX.Y.Z && git push origin cli-vX.Y.Z`. Never tag by hand from a branch.
3. The workflow refuses a tag whose commit is not on the default branch, checks the tag equals the package version (`scripts/release-cli.ts`, tested in
   `tests/release-cli.test.ts`), runs the whole test suite on a fresh build, then, in a second job that runs none of
   the repository's code, attests the files and runs `gh release create`. A pre-release version (`X.Y.Z-rc.1`) is
   marked as a pre-release. A failed run before the release exists can be re-run from the tag; a release that exists
   is never replaced: bump the version instead.
4. *Run workflow* from a branch is a dry run: it uploads the files as a workflow artifact and makes no release.

Keep `release-cli.yml` and `action/install-cli/action.yml` the only places that name the asset
(`terragram-<version>.mjs`) and the tag (`cli-v<version>`); change them together. `action/install-cli` writes
`GITHUB_PATH`, which zizmor flags in every composite action; the one inline `zizmor: ignore[github-env]` is the
exception, and any other write still fails the build.

## Graph rendering: `terragram-engine/graph`, `terragram graph`

The one renderer of an *existing* estate (the design features draw a model; this draws infraharvest's
`graph/v1`). The platform web app imports the module and infraharvest's and Infraweaver's Actions call
the CLI, so its output is a contract.

- **Pipeline.** `parseGraphDocument` (zod, mirrors `schemas/vendor/infraharvest/graph-v1.schema.json`)
  → `normalizeGraph` (index-free keys, glue folded away) → `projectGraph` (the `GraphView`: groups,
  nodes, edges, statuses, finding tallies) → `renderGraphSvg` / `renderGraphMermaid`. Layout is
  dagre as a compound graph, boxes drawn around members (`graph/layout.ts`).
- **Deterministic by construction.** Every order is by key with `compareText` (never `localeCompare`),
  ids are assigned after sorting, coordinates are rounded, nothing reads the clock or the environment.
  `tests/graph.test.ts` shuffles the input and requires identical bytes; keep that when adding output.
- **Goldens** are in `tests/fixtures/graph/golden/`; `UPDATE_GOLDEN=1 npm test` rewrites them, then read
  the diff. The vendored schema is copied unchanged from infraharvest (commit in its README); to
  update it, copy it and change the commit.
- **Glue** is data (`graph/glue.ts`, `DEFAULT_GLUE`): a type list, patterns and a keep list. Changing
  it changes every picture, so change the goldens with it and say why in the PR.
- **graph/v1 has no addresses and no environments**, so findings match by `type` + `id` or `account`
  only; do not add a heuristic that guesses from an address.

## The Action: `action/`

`hibiscus-ctrl/terragram/action@<sha>` (`action/action.yml`, runtime `node24`) is a second host of the engine. It reads
a model file (default `diagram.json`), regenerates the Terraform in memory and either fails on drift (`check`, with a
unified diff) or writes the files (`write`); on a pull request it posts one sticky comment with the model diff as Mermaid.
Usage and the security notes are in `action/README.md`.

- **Same boundary as the CLI.** Engine public exports (`terragram-engine/<subpath>`) and Node only: `action-*` rules in
  `.dependency-cruiser.cjs`, and `tests/action-bundle.test.ts` checks every specifier against the engine's `exports`. No
  `@actions/*`: the runner protocol (`workflow.ts`) and the REST calls (`comment.ts`) are small enough to own.
- **`action/dist/index.mjs` is committed**, because a workflow runs it from the checkout. Rebuild it with
  `npm run build:action` after any change to `action/src` or the engine, and commit it with the change. The `action-dist`
  CI job and `tests/action-bundle.test.ts` fail when it is stale. It is deliberately not minified.
- **Seams.** `Host` (`workflow.ts`) carries the environment, fetch, git and clock, so `tests/action-e2e.test.ts` runs the
  built bundle against a local fake of GitHub. `upload.ts` is the only place a control plane will be called: today it
  sends nothing.
- **Hostile text.** Component labels come from the pull request. They are entity-encoded before Mermaid or markdown, and
  `Workflow.log` never lets a line start a workflow command. The comment is only ever updated when a bot wrote it, and
  the Action refuses `pull_request_target`. Keep those tests (`tests/action-render.test.ts`, `tests/action-comment.test.ts`).
- **The fixture** (`tests/fixtures/action/`) is a model and the Terraform the engine generates for it; `action-selftest.yml`
  and the e2e test both run the Action over it. A generator change that alters the Terraform makes both fail:
  regenerate the fixture by running the built Action with `INPUT_MODE=write` over a copy.
- **The signing key** (`signing-key`) is masked line by line and never logged or written. Errors about it do not quote it.

## Secrets

- Never `console.*` an error object that may carry a request: provider errors embed the request that carried the
  credential. The Action's `Workflow.log` and the engine's `Logger` port are where output goes.
- Keys and tokens are never committed, in code, tests or fixtures. Tests generate their own keys.

## Biome

- **The formatter is OFF** (lint rules only). Never run
  `biome check --write`, `lint:fix` or any formatter over the tree. Format only the files you
  changed.
- **Never put `//` comments in `biome.json`.** Biome silently discards the whole config and falls
  back to defaults. The tell is a file count in the thousands instead of a few hundred. Keep
  `$schema` on the installed version.
- The pre-commit hook (`lefthook.yml`) lints staged files only.

## Hand-synced with another repo: change one, change both

- `packages/engine/src/managed-models.ts` `MANAGED_MODEL_IDS` <=> the model gateway's `bedrock_model_map`, pinned by
  `contracts/model-map.json`, a copy kept by hand: when the gateway's map changes, copy its `contracts/model-map.json`
  here in the same change. `tests/model-map-contract.test.ts` checks that every offered model is in the copy.

## `@infraweaver-io/*` are real dependencies

- `core`, `sandbox` and `attest` resolve from GitHub Packages through the registry scope line in the
  repository's npm config. Auth is never committed: the user's npm config locally, `GH_PACKAGES_TOKEN` in CI.
- This repo is not in the `infraweaver-io` org, so the job's `GITHUB_TOKEN` cannot read the
  packages.
- A change in `infraweaver-packages` does nothing here until it is published and the version
  bumped.

## Working rules

- Planning and assessment notes (`TERRAGRAM-*.md`) are local only: never commit, push or link
  them, and don't cite them in code comments.
- Commits are plain Conventional Commits, with no AI attribution. `pull.rebase=true`, no merge
  commits on `main`.
- Simplest thing that works, surgical diffs, and a test that reproduces a bug before the fix.
