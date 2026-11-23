# Changelog

All notable changes to Terragram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `terragram graph` and the `terragram-engine/graph` renderer: draw an existing estate from infraharvest's
  `graph/v1` document as SVG, Mermaid or JSON, with scopes, environments and module calls as boxes, findings placed by Terraform address (told apart by environment and by the root a node was generated in), a diff against an earlier
  document and finding overlays.
- The Action's `control-plane-url` now uploads the receipt bundle from a push to the default branch: it exchanges the job's GitHub
  identity token (`id-token: write`) for a repository-pinned token and sends the bundle to the
  control plane's `/api/v1/ingest/diagram`, failing the step with the control plane's reason when it
  is refused. New input `control-plane-audience` and output `snapshot-id`.
- `schemas/diagram-bundle-v1.schema.json`, the JSON Schema of the document the Action uploads
  (`diagram.bundle/v1`), so a control plane can validate what it receives. The Action's own tests check the
  document it sends against it.

### Changed

- Names that end up in documents, generated code or a repository say `diagram`
  instead of the codename: the schema ids (`diagram.model/v1`,
  `diagram.receipt/v2`, `diagram.graph-view/v1`), the `ManagedBy = "diagram"`
  tag and the header comment in generated Terraform, and the Action's default
  model file (`diagram.json`), output directory (`_diagram/`), pull request
  comment marker and heading. `terragram verify` still accepts receipts that
  carry the `terragram.receipt/v1` and `terragram.receipt/v2` ids. The
  repository, packages and `terragram` command keep their names.

### Removed

- The Next.js web app: the marketing site, the diagram workspace, account and
  billing, the API routes, the Supabase migrations, the Cypress suite and the
  deploy files (Dockerfile, Railway). The repository is now the TypeScript
  engine (`terragram-engine`), the `terragram` command line, the GitHub Action
  and the JSON Schemas, with their tests and CI.
- Engine code that only the app used: the workspace settings schema, the mode
  and format metadata, the share-link expiry check, and the compose suggestions.

### Fixed

- The Action uploads the receipt bundle only from a `push` run, as its README says. Before, any event except
  `pull_request` (a `workflow_run` that checked out a fork's head, a `workflow_dispatch`, a `schedule`) uploaded
  with the repository's identity; those runs now skip the upload and say why.
- Text from a model file stays text in the generated Terraform: `${` and `%{` in a quoted value are written as
  `$${` and `%%{`, and control characters and newlines as escapes, so a `diagram.json` can no longer turn a
  field such as the DNS zone name into a Terraform expression. The two free-text fields are now checked:
  "Zone name" must be a DNS name and "Address space" an IPv4 CIDR block, otherwise `terragram` and the Action
  stop with a message naming the component, the field and the value.
- Bundle verification (`terragram-engine/verify`) accepts the plan files an AWS function component adds under
  `plan/src/<slug>/`, so `terragram verify` and any host that verifies a bundle no longer refuse them. A plan
  file is accepted when its name is a plain relative path inside `plan/` (no `..`, empty segment, absolute path
  or backslash) and the receipt records it, so a file the content hash does not cover is still refused.
- `verifyBundle` takes `trustedKeys` (signer public keys obtained apart from the bundle) and no longer reports
  `ok` on a key the bundle carries itself: without a trusted key the result is not `ok` unless the caller passes
  `acceptBundledKey`. A receipt that says `signed` but has no signature fails, and a `model.json` that is not JSON
  returns a failure report instead of rejecting. `terragram verify` behaves as before.

[Unreleased]: https://github.com/hibiscus-ctrl/terragram/commits/main
