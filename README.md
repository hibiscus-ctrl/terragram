# Terragram**Terragram** turns a plain-English brief, a Mermaid flowchart or an architecture diagram into reviewed
Terraform or OpenTofu, and reads Terraform back into a diagram, through one auditable internal model.
This repository holds the TypeScript engine that does it, a command line over that engine, and a GitHub
Action that keeps a repository's Terraform in line with a model file.

> Licensed under [AGPL-3.0-only](./LICENSE). The JSON Schemas under [`schemas/`](schemas/) are Apache-2.0.

## What is here

| Path | What it is |
| --- | --- |
| [`packages/engine`](packages/engine) | `terragram-engine`: the model and kind registry, the Terraform/OpenTofu emitter, the HCL parser, Mermaid import, verifier, explainer, evidence receipts, layout and SVG export. Pure functions: models, signing and logging come in through ports. |
| [`packages/cli`](packages/cli) | `terragram`: the command line, bundled into one file with no runtime dependencies. |
| [`action`](action) | The GitHub Action, one committed bundle, and `action/install-cli`, the action that installs a released command line. See [`action/README.md`](action/README.md). |
| [`schemas`](schemas) | JSON Schemas for the model (`diagram.model/v1`) and the evidence receipt (`diagram.receipt/v2`), generated from the engine's zod schemas. |
| [`scripts`](scripts) | The release gates (generated-Terraform validation, module-interface check, schema generation) and the provider-version refresher. |

The engine is deterministic: keyword compose, HCL parse and template emit, with no model call and no
key. Words, diagram and code never drift because all three flow through one internal model
(`packages/engine/src/model.ts`), and every Terraform resource comes from the registry in
`packages/engine/src/kinds.ts`. The engine also has a managed-inference path (a forced tool call over a
`ModelClient` port, plus diagram reading from a picture) that a host binds to its own gateway and spend
cap; the CLI does not use it yet.

Nothing here runs a service. Nothing is published to a registry yet: install the command line from a GitHub release, or from source.

## Install

You need Node.js 24 or later. Each `cli-v<version>` tag publishes a
[GitHub release](https://github.com/hibiscus-ctrl/terragram/releases) with the command line as one file, with no
runtime dependencies, beside a `SHA256SUMS` file:

```bash
version=0.1.0
curl --fail --location --proto '=https' --tlsv1.2 --remote-name \
  "https://github.com/hibiscus-ctrl/terragram/releases/download/cli-v${version}/terragram-${version}.mjs"
echo "<sha256 from the release's SHA256SUMS>  terragram-${version}.mjs" | sha256sum --check --strict
gh attestation verify "terragram-${version}.mjs" --repo hibiscus-ctrl/terragram \
  --signer-workflow hibiscus-ctrl/terragram/.github/workflows/release-cli.yml \
  --source-ref "refs/tags/cli-v${version}"
node "terragram-${version}.mjs" --help
```

Keep the SHA-256 where you pin the version (in a workflow, a lockfile or a script), not only on the release
page, so a changed asset fails the check instead of running. The attestation is signed by this repository's
`release-cli.yml` workflow and names the tag it ran for, so it shows that the file came from that tag's source.

In another repository's workflow, `hibiscus-ctrl/terragram/action/install-cli@<full commit SHA>` does the
download, both checks and puts `terragram` on `PATH`; it needs Node 24 on the runner and a Linux or macOS runner:

```yaml
- uses: actions/setup-node@<full commit SHA>
  with:
    node-version: "24"
- uses: hibiscus-ctrl/terragram/action/install-cli@<full commit SHA>
  with:
    version: "0.1.0"
    sha256: "<sha256 from the release's SHA256SUMS>"
    # verify-attestation: "true" (default) fails the step when `gh attestation verify` fails
- run: terragram generate --mermaid diagram.mmd -o infra/
```

## Install from source

You need Node.js 24 or later and npm. Terraform or OpenTofu is only needed for the formatting check
and the generated-Terraform gate.

```bash
npm ci            # @infraweaver-io/* come from GitHub Packages, so this needs a read:packages token
npm run build:packages
node packages/cli/dist/terragram.mjs --help
```

## Command line

`terragram` runs offline with no model and no account.

```bash
terragram generate --prompt "A web app with a Postgres database" --cloud aws -o out/   # Terraform + model.json
terragram generate --mermaid diagram.mmd --tofu -o out/                               # from a Mermaid flowchart
terragram parse infra/ -o model.json                                                  # Terraform -> model
terragram render model.json -o diagram.svg
terragram explain model.json                                                          # plain-English description
terragram graph graph.json -o estate.svg                                              # an existing estate, from infraharvest
terragram verify bundle/ --key signer.pem                                             # offline receipt check
```

`verify` reports "verified" only when the content hash recomputed from `model.json` and `plan/`
matches **and** the receipt's signature verifies against a public key you hold: `--key signer.pem`,
or `--trust keys.json` (a JSON object of key id to PEM, picked by the receipt's key id). The key must
come from outside the bundle; `signing-key.pem` inside it is never used, since whoever alters a
bundle can swap the key. An unsigned receipt fails; `--allow-unsigned` checks the hashes only and
prints `UNSIGNED`, which is not a pass.

Exit status is 0 on success, 1 when a command fails (including a receipt that does not verify) and 2
for bad arguments; `--json` prints a machine-readable result where it helps.

## GitHub Action

`hibiscus-ctrl/terragram/action@<full commit SHA>` regenerates the Terraform from a `diagram.json`
model file and fails the check when the committed Terraform differs, or writes the files. On a pull
request it posts one comment with the model diff as a Mermaid diagram. Usage, inputs, outputs and the
security notes are in [`action/README.md`](action/README.md).

## Graph rendering

`terragram graph` draws an estate that already exists, from the `graph/v1` document
`infraharvest export --schema graph` writes (its JSON Schema is vendored in
[`schemas/vendor/infraharvest/`](schemas/vendor/infraharvest/)). It is the one diagram renderer
for pull request comments and for the platform's web app: the same document gives the same bytes,
whatever order it lists its nodes in.

```bash
terragram graph graph.json -o estate.svg                       # SVG (default); --format mermaid | json
terragram graph graph.json --base main/graph.json              # mark what was added, removed, changed
terragram graph graph.json --base main/graph.json --delta      # only the changes and one reference of context
terragram graph graph.json --findings ocsf-findings.json       # lay findings over it
```

An account (or subscription, or project) is a box, an environment is a box inside it when the graph
names the environment of its roots, a module call is a box inside that, and an arrow runs from a
resource to what it refers to. A graph that names no environment has no environment boxes. **Glue is hidden**: attachments and associations
(`*_attachment`, `*_association`), `aws_iam_role_policy` and its kin, Google IAM bindings,
`random_*`, `time_*`, `null_resource`, `terraform_data`; a line that went through one still joins
the two ends, and the footer counts what was hidden. The rule is `DEFAULT_GLUE`, which
`projectGraph` takes a replacement for (`glue: false` hides nothing; the CLI has `--show-glue`,
`--hide` and `--keep`).

Findings are placed by what `graph/v1` can name: a resource by its `type` and `id`, or by its Terraform
address when the graph keeps addresses (`redaction.addresses: plain`; a module call by `module.<name>`), a scope
by its `account`. infraharvest's `ocsf-findings` land on the account of the root they were found in.
The same address recurs in every root, so a finding with only an address is placed when exactly one node
has it, narrowed by the finding's `account` and `environment` when it names them. A finding that cannot be
placed that way (a hashed or dropped address, or an address several nodes share) is counted as not placed
unless the caller resolves it (`resolveAddress`), never guessed at.

In code, import `terragram-engine/graph`: `parseGraphDocument`, `projectGraph(doc, options)` (a view
model), `renderGraphSvg(view)`, `renderGraphMermaid(view)` and `diffGraphs(base, head)`.

## Schemas

[`schemas/model.v1.schema.json`](schemas/model.v1.schema.json) and
[`schemas/receipt.v2.schema.json`](schemas/receipt.v2.schema.json) describe the documents the CLI and
the Action read and write. They are Apache-2.0, so a tool can build against the formats without taking
on the AGPL, and they are generated (`npm run schemas:gen`), not hand-written.

## Scripts

| Script | What it does |
| --- | --- |
| `npm test` | Unit tests (the node built-in runner, `tests/**/*.test.ts`) |
| `npm run test:coverage` | The same suite under c8, with floors for the engine and CLI |
| `npm run typecheck:all` | `tsc` over the tests and scripts, the engine, the CLI and the Action |
| `npm run lint:ci` / `lint:ox` | Biome / oxlint |
| `npm run check:imports` | Import rules (dependency-cruiser) and the engine-reads-no-environment check |
| `npm run knip` | Unused files, exports and dependencies |
| `npm run build:packages` | Bundle the CLI (`packages/cli/dist/terragram.mjs`) and build the engine library (`packages/engine/dist`) |
| `node scripts/release-cli.ts version [<tag>]` | The CLI's version; with a tag, fails unless the tag names it (the release workflow's gate) |
| `npm run build:action` | Rebuild the committed Action bundle (`action/dist/index.mjs`) |
| `npm run schemas:gen` / `schemas:check` | Write / verify `schemas/*.schema.json` |
| `npm run validate:emit` | The generated-Terraform gate: `fmt`, `validate`, tflint, trivy and checkov over every brief and template, then Infraweaver's assess |
| `npm run check:modules` | Check every pinned module call against its published interface |
| `npm run refresh:providers` | Refresh the pinned provider and module versions the emitter writes |

Biome handles linting only (its formatter is off): match the surrounding style by hand.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and [`SECURITY.md`](SECURITY.md) for
responsible disclosure.
