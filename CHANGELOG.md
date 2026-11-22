# Changelog

All notable changes to Terragram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- The Next.js web app: the marketing site, the diagram workspace, account and
  billing, the API routes, the Supabase migrations, the Cypress suite and the
  deploy files (Dockerfile, Railway). The repository is now the TypeScript
  engine (`terragram-engine`), the `terragram` command line, the GitHub Action
  and the JSON Schemas, with their tests and CI.
- Engine code that only the app used: the workspace settings schema, the mode
  and format metadata, the share-link expiry check, the compose suggestions and
  the node-position and edge-removal editor helpers.

### Added

- A GitHub Action that checks or writes Terraform from a model file, and a
  `terragram` command line (`generate`, `parse`, `render`, `explain`,
  `verify`) over the same engine, with JSON Schemas for the model and the
  evidence receipt.

[Unreleased]: https://github.com/hibiscus-ctrl/terragram/commits/main
