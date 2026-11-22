# Changelog

All notable changes to Terragram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Action's `control-plane-url` now uploads the receipt bundle: it exchanges the job's GitHub
  identity token (`id-token: write`) for a repository-pinned token and sends the bundle to the
  control plane's `/api/v1/ingest/diagram`, failing the step with the control plane's reason when it
  is refused. New input `control-plane-audience` and output `snapshot-id`.

### Removed

- The Next.js web app: the marketing site, the diagram workspace, account and
  billing, the API routes, the Supabase migrations, the Cypress suite and the
  deploy files (Dockerfile, Railway). The repository is now the TypeScript
  engine (`terragram-engine`), the `terragram` command line, the GitHub Action
  and the JSON Schemas, with their tests and CI.
- Engine code that only the app used: the workspace settings schema, the mode
  and format metadata, the share-link expiry check, the compose suggestions and
  the node-position and edge-removal editor helpers.

### Changed

- Names that end up in documents, generated code or a repository say `diagram`
  instead of the codename: the schema ids (`diagram.model/v1`,
  `diagram.receipt/v2`, `diagram.graph-view/v1`), the `ManagedBy = "diagram"`
  tag and the header comment in generated Terraform, and the Action's default
  model file (`diagram.json`), output directory (`_diagram/`), pull request
  comment marker and heading. `terragram verify` still accepts receipts that
  carry the `terragram.receipt/v1` and `terragram.receipt/v2` ids. The
  repository, packages and `terragram` command keep their names.

### Added

- A GitHub Action that checks or writes Terraform from a model file, and a
  `terragram` command line (`generate`, `parse`, `render`, `explain`,
  `verify`) over the same engine, with JSON Schemas for the model and the
  evidence receipt.
- A release workflow (`release-cli.yml`) that publishes the command line as one
  file, `terragram-<version>.mjs`, with a `SHA256SUMS` file and build
  provenance, on a GitHub release when a `cli-v<version>` tag is pushed, and an
  `action/install-cli` action that downloads a pinned version, checks its
  SHA-256 and attestation, and puts `terragram` on the runner's PATH.

[Unreleased]: https://github.com/hibiscus-ctrl/terragram/commits/main
