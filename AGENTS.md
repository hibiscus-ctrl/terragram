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

- **Typed edges** (`iam.ts`, read by `parse.ts`). An edge may carry `access`: `runs-as` (a workload to the role or identity in
  its `role`, `task_role_arn`, `iam_instance_profile` or `identity_ids`), `read`/`write`/`admin` (an identity to a drawn resource its
  policy or role assignment names, by the strongest action or role there) or `unscoped` (to the conceptual `any-resource` node:
  a wildcard anywhere in a resource, `NotResource`, a policy the text does not show, a managed policy that is neither defined in the file nor in the table below, an Azure
  role over anything but one drawn resource). The policy is read as text, never evaluated, and never kept: the model gets edges, not
  statements. Understating access is the dangerous direction, so whatever the reader is not certain of (an attribute it cannot read, a
  template that is not one drawn reference, an action with a character it cannot match, nesting past 64 levels) is `unscoped`, never dropped.
  Deny statements are not read. A statement with a real Condition (an object of operators, or a static `condition` block) marks its edges
  `conditional: true`: the level is unchanged, the edge is never dropped or lowered, and it stays conditional only while every grant at its
  strongest level is (`mergeAccess`), and then carries `unconditional`: the strongest level some grant gives with no condition, so a lower
  unconditional grant is never hidden behind a conditional higher one. A condition that is always true (`Null`, `...IfExists`, a value that is only `*`) is not counted.
  The condition's own text is never read into the model. A new reader that needs the policy's words in the model is a schema decision, not a tweak.
  AWS managed policies attached by a literal `arn:aws:iam::aws:policy/...` ARN (or `arn:${data.aws_partition.x.partition}:...`) are typed from
  `aws-managed-policies.ts`: a small bundled table (~55 well-known policies, dated by `AWS_MANAGED_POLICIES_VERSION`) of the level each grants per
  service, read from the policy's own document in the AWS reference with the same action rule as an inline policy. Its header says how rows
  are made and which three adjustments were reviewed; regenerate a row when AWS changes the policy, do not hand-edit a level down. A managed policy
  is on Resource `*`, so every grant always has an `any-resource` edge at its level, plus an edge to each drawn resource of its service (`SERVICE_RESOURCE_TYPES`)
  unless none is drawn or there are more than `MAX_MANAGED_TARGETS`/`MAX_MANAGED_EDGES` allow. The table lists every service a policy grants on,
  drawn or not (a service with no drawn type is the `any-resource` edge alone). An ARN not in the table stays `unscoped`.
  **Every cloud's grants are read in every file** (`readIam` runs `readAws`, `readAzure` and `readGcp` whichever cloud the file goes to): a grant no reader read is a grant the picture understates.
  **Google Cloud IAM** (`readGcp` in `iam.ts`) reads `google_<service>_iam_member|binding|policy` the same way: the role by its name
  alone (`gcpRoleLevel`: `roles/owner`, `roles/editor` and `roles/cloudbuild.builds.editor` are `admin` since they mint keys for or act as any service account, then the last
  camelCase word of a predefined one, else `unscoped`), a `condition` block as conditional only when its CEL expression looks at the request or the resource
  (`gcpExpressionNarrows`: not a constant or a tautology, not an `||` beside a literal, not only a lower bound on `request.time`, not past 4000 characters; when unsure it is not counted),
  the target by the attribute of its service (`GCP_TARGET_ATTRIBUTES`), and a project, folder, organisation or billing
  account grant as an edge to `any-resource` at the role's level, never a narrower edge instead. A principal that is not a drawn node is one of a fixed set
  of stand-in nodes (`GCP_PRINCIPALS`, ids `principal-*`, category `edge`, wording fixed here), never named from the member's text, so there are
  at most eight and no address reaches the model. Whatever it cannot read (a role, a member, a target, a policy document, past the caps) is
  `unscoped` or `principal-other`, never dropped. A member that may be anyone (a `concat()`, a `for` expression, a variable, a template that starts with one) is an `unscoped`
  edge from `principal-other`. A grant on a resource the picture does not draw (an Artifact Registry repository, a Spanner database) is an edge to `any-resource` at the role's level,
  not nothing; a type with no target attribute is on a drawn node only when an attribute that is not a place (`zone`, `location`, ...) points at it. A role to act as a service account
  (`roles/iam.serviceAccountUser`, `serviceAccountTokenCreator`) is `runs-as` only from a drawn workload or account, `admin` from a person, an account that is not drawn, a
  federated identity or another principal, `unscoped` from a group, a domain or the public, and `unscoped` on anything that is not a service account.
  Access that is not a role is read too, as `unscoped` edges from the principals it names: the storage ACL resources (`GCP_ACL_TYPES`: `role_entity`, `entity`, `predefined_acl`), `google_bigquery_dataset_access`
  and the `access` blocks of a `google_bigquery_dataset`. A document read by many policies is read once (`readDocument`), and a file's Google Cloud grants cost at most `MAX_GCP_WORK`
  units; past that, or past any other cap, one unscoped edge from `principal-other` stands for the rest. A new Google resource type that
  grants access goes in `GCP_TARGET_ATTRIBUTES` with a test; an unlisted one is read by whatever its attributes point at.
  **A grant on oneself is not an edge.** `readIam` keeps edges whose source is their target out of `edges` and returns the ones that are `admin` or `unscoped` as `self`
  (an inline or managed policy that reaches the role's own node, an Azure role over the identity's own id, `serviceAccountTokenCreator` or an `...Admin` role on a service account for itself);
  `parse` sets `selfAccess` (`admin`|`unscoped`) and `selfConditional` on the node, which counts as admin wherever access is shown (`selfAccessPhrase` in `model.ts` is the one wording:
  `explain`, the SVG card, the Mermaid node and the Action's "Access changes" list all use it; `model-diff` counts it in a node's signature). Reads and writes on oneself and
  `serviceAccountUser` on itself are not recorded. A new reader of grants must not filter `source === target` itself. The table's IAM reads (`["iam", "read"]`) come from the policy documents; do not drop them for being "console only".
  Renderers take the wording and colour from `EDGE_ACCESS_META` (`model.ts`); an untyped edge must still draw exactly as before.
- **Google Cloud is read, not generated** (`gcp` in `CLOUDS`, not in `GENERATED_CLOUDS`). A file is `gcp` only when it has no AWS or Azure resource or module in it (`detectCloud`); otherwise it goes to the one of those it has most of, and `assessFeasibility` says which Google parts that cloud cannot build. A kind's `gcp` entry is a `ReadSpec`
  (`type`, `matches`, `matchBlock`, `read`, `moduleSource`): what a `google_*` resource or Google registry module reverse-maps to, never an
  `emit`. `cloudSpec(kind, "gcp")` is always null, so anything that asks "can this be built" (`emitTerraform`, `assessFeasibility`) treats
  the cloud as having no plan: `emitTerraform` returns no files, no provider and no modules, a receipt's `plan` is `[]` (`verifyBundle` hashes
  the model alone), and `parseCloud` for `generate` takes only `GENERATED_CLOUDS`. Code that iterates clouds to emit (the emit gate, the
  module-input check, the generation tests, the managed models' `cloud` enums) iterates `GENERATED_CLOUDS`, not `CLOUDS`. A kind only Google
  Cloud has (`project`, `kubernetes`, `virtual-machine`, `data-warehouse`) is left out of `MODEL_KIND_IDS`. The `project` kind is a container:
  `parse` draws no plain edge to it, and the entry point of the picture is never it. To add emission for Google Cloud later, give a kind an
  `emit`, move `gcp` into `GENERATED_CLOUDS` and put it through `validate:emit`; do not half-do it.
- **Azure SKU check** (`azure-sku.ts`, data in `azure-sku-data.ts`). `generate` and the Action run `checkAzureSkus` over the
  emitted files and report its findings as warnings (CLI notes, the Action's report). It parses the HCL, reads the SKU argument of
  the module or raw resource of each kind it knows (`BINDINGS`), and the region from `location` (a string, a variable default or
  `module.<name>.location`); anything it cannot read is skipped. `azure-sku-data.ts` is generated by `npm run refresh:azure-skus`
  (azurerm docs for which SKUs exist; Azure Retail Prices API for the regions that price them; no credentials), never edited
  by hand and never fetched at generate time. A new Azure kind that names a SKU needs a `BINDINGS` entry and a rule in
  `scripts/refresh-azure-skus.mjs`; `tests/workspace-azure-sku.test.ts` fails if the data and rules disagree, and if the
  emitter writes a SKU the data does not know.

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
  and dagre stay external). No `@infraweaver-io/*` package is a dependency, so `npm ci` reaches only the public
  registry; `tests/cli-bundle.test.ts` fails if such a specifier ever appears in the bundle, and runs the bundle from a directory with no `node_modules`. The engine's
  `exports` still point at `src/`; they flip to `dist/` when it is published, which this repo does not
  do yet: both packages are `"private": true`, with no npm publish. The CLI bundle is published as a GitHub
  release asset by `release-cli.yml` (below).
- **Schemas.** `schemas/*.schema.json` (Apache-2.0, REUSE-annotated) are generated by
  `npm run schemas:gen` from `modelDocumentSchema` (`model.ts`) and `evidenceReceiptSchema`
  (`receipt-schema.ts`); CI runs `schemas:check`. Change a document's shape in the zod schema, regenerate
  and commit the schema. `tests/schemas.test.ts` validates real documents with Ajv and ties the
  receipt schema to the `EvidenceReceipt` type. Ids are `diagram.model/v1` and `diagram.receipt/v3`
  (dots, as the receipt always has); `$id` URLs sit under the repository for now and will move with
  the name. `schemas/diagram-bundle-v1.schema.json` is the exception: it describes the document the Action uploads
  (`action/src/upload.ts`), which the Action owns rather than the engine, so it is written by hand, and
  `tests/action-upload.test.ts` validates the document the Action really sends against it; change both together.
  `diagram.receipt/v3` hashes a JSON canonical form in code-unit order (`canonicalPayload` in `receipt.ts`,
  worded in the schema); `diagram.receipt/v2` hashed with the process locale and unescaped delimiters.
  `verifyBundle` and `terragram verify` pick the hash by the receipt's schema id: v3 by the canonical form,
  `diagram.receipt/v2` and the `terragram.receipt/v1`/`v2` ids by the original one, kept unchanged so issued
  receipts verify (`VERIFIABLE_RECEIPT_SCHEMAS`); any other id is refused. New receipts are always v3. A change to
  what the v3 hash covers needs a new schema id, never an edit. The model reader accepts only `diagram.model/v1`.
  Adding a value to an enum (a cloud, an access level) is additive inside a version: a document without the new value is byte for byte what it was, and
  a consumer that validates against a closed list must learn the value before it sees one, which is the fail-closed outcome. `gcp` joined `cloud` that way, and the
  schemas say so in the field's `description` (`CLOUD_DESCRIPTION`). A new id is for a change to what a hash covers or to what an existing value means, since it would
  otherwise force every Azure and AWS document to be reissued.
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
  nodes, edges, statuses, finding tallies) → `renderGraphSvg` / `renderGraphDrawio` / `renderGraphMermaid`. Layout is
  dagre as a compound graph, boxes drawn around members (`graph/layout.ts`).
- **Deterministic by construction.** Every order is by key with `compareText` (never `localeCompare`; the receipt hash, the preview id and the variable order included),
  ids are assigned after sorting, coordinates are rounded, nothing reads the clock or the environment.
  The one order of a picture (`byPlace` in `graph/project.ts`) is scope, environment name, module path
  (the module call's address), resource address, root, then the key; an address or root counts only when
  the graph keeps it plain, so a hashed or dropped one falls back to the key. Groups, node ids and edges
  all follow it: never sort a part of the picture by anything else.
- **draw.io** (`graph/drawio.ts`) reuses `layoutGraph`'s boxes (a card is relative to its container) and the SVG's colours, never
  writes `html=1`, and escapes every label with `attr`; it writes only what the picture shows, so keep it that way.
  `tests/graph.test.ts` shuffles the input and requires identical bytes; keep that when adding output.
- **Goldens** are in `tests/fixtures/graph/golden/`; `UPDATE_GOLDEN=1 npm test` rewrites them, then read
  the diff. The vendored schema is copied unchanged from infraharvest (commit in its README); to
  update it, copy it and change the commit.
- **Glue** is data (`graph/glue.ts`, `DEFAULT_GLUE`): a type list, patterns and a keep list. Changing
  it changes every picture, so change the goldens with it and say why in the PR.
- **graph/v1 may have addresses, environments and roots, but not always** (an address may be hashed or dropped, and a graph from
  before them has none), so findings match by the graph's own address narrowed by `account`, `environment` and `root`, or by
  `type` + `id`, or by `account` only; do not add a heuristic that guesses from an address.

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

## No restricted packages

- `npm ci` reads the public npm registry only, so an outside contributor needs no token. The release gates in
  `scripts/` use their own small helpers (`scripts/lib/runtime.ts`) rather than the `@infraweaver-io/*` packages,
  and the tests use `node:crypto`. Do not add a dependency on a package from GitHub Packages.

## Working rules

- Planning and assessment notes (`TERRAGRAM-*.md`) are local only: never commit, push or link
  them, and don't cite them in code comments.
- Commits are plain Conventional Commits, with no AI attribution. `pull.rebase=true`, no merge
  commits on `main`.
- Simplest thing that works, surgical diffs, and a test that reproduces a bug before the fix.
