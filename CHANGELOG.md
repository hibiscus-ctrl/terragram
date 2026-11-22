# Changelog

All notable changes to Terragram (`terragram-ui`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Terragram product, built out of the inherited codebase in seven phases:
  rebrand + design system ("The Cartographer's Table"), the strip of the
  inherited product surfaces, the marketing site, the React Flow diagram
  workspace (four modes, review gate, code + evidence panes), the translation
  engine (deterministic by default, managed UK inference behind
  `WORKSPACE_ENGINE=managed` with automatic fallback), workspace persistence
  (`workspaces` + `workspace_snapshots`, owner-only RLS, ephemeral degradation),
  and the WCAG 2.2 AA hardening pass.
- Personal accounts: `/billing` + `/settings` (the org is a 1:1 implementation
  detail resolved ambiently — no org slug in any URL).

### Security

- `/api/workspace/translate` is rate-limited per user, caps its request body,
  and only routes to managed (paid) inference for a managed-entitled org —
  everyone else gets the deterministic engine.
- The managed-inference usage callback warn-logs when the dedicated
  `TERRAGRAM_PROXY_CALLBACK_SECRET` is absent and it falls back to the
  token-signing secret.

[Unreleased]: https://github.com/IgnatG/diagram.infraoath-ui/commits/main
