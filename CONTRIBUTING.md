# Contributing to Terragram

Thank you for helping. This page is the process: setting up, checking a change, and getting it merged. By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Workflow

- Fork the repository (or branch, if you have write access) and open the pull request against `main`.
- Name the branch after the change's type: `fix/receipt-key-id`, `feat/azure-kinds`, `docs/action-usage`.
- Keep pull requests focused: one logical change each. A bug fix includes a test that fails without the fix.
- Say in the description what changes and why, and how you tested it. The PR validation check fails on an empty or unfilled template.
- A pull request merges once every check is green, the [CLA](#contributor-license-agreement) check included.

## Contributor License Agreement

Contributions are accepted under the [Contributor License Agreement](CLA.md). Terragram is AGPL-3.0-only, and the project owner may also offer it under other licence terms. That only works if every contribution can be relicensed, which is the right the CLA grants. A DCO sign-off isn't enough: it says you had the right to submit the change, but grants no relicensing right.

The `cla` workflow asks on your first pull request: comment

> I have read the CLA Document and I hereby sign the CLA

once, and it covers all your later pull requests. The `CLA` status check can't go green, so the pull request can't merge, until every author of its commits has signed.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), as [.github/COMMIT_CONVENTION.md](.github/COMMIT_CONVENTION.md) describes:

```text
fix(cli): reject a receipt whose key id is not trusted
feat(engine): add an Azure storage kind
ci: pin actions to commit SHAs
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `ci`, `build`, `chore`, `revert`. A breaking change takes `!` and a `BREAKING CHANGE:` footer saying what users must change. Describe only what the diff changes.

## Setting up

Terragram is a TypeScript monorepo (the engine, the CLI and the GitHub Action). It needs **Node 24** (`engines`, `.nvmrc`) and **npm**, not pnpm:

```bash
npm ci
```

`@infraweaver-io/*` packages come from GitHub Packages, so `npm ci` needs a token with `read:packages` for them. If you can't get one, open the pull request anyway and say so: a maintainer will help get the checks run.

[README.md](README.md) covers what is in the repository and how to build it. [AGENTS.md](AGENTS.md) covers the conventions the code follows (the engine boundary, the CLI and Action rules, the committed Action bundle), and applies to people as much as to coding agents.

## Checking a change

Run the gates CI runs before you push:

```bash
npm run typecheck:all      # tests and scripts, the engine, the CLI and the Action
npm test                   # unit tests (node --test)
npm run lint:ci            # Biome
npm run lint:ox            # oxlint
npm run check:imports      # import rules (.dependency-cruiser.cjs)
npm run knip               # unused files, exports and dependencies
npm run build:packages     # the CLI bundle and the engine library
npm run build:action       # the committed Action bundle; commit it with the change
```

A change to what the engine emits also needs `npm run validate:emit` and `npm run check:modules`, which need Terraform and Docker. A change to a document's shape needs `npm run schemas:gen`. CI also runs the coverage floor, `reuse lint` and the security scans described below.

Two gates that aren't a command: **never commit credentials, tokens or customer data** (in code, tests or fixtures), and **never weaken a guardrail to make a feature work**.

## Licence headers

Every TypeScript and JavaScript file starts with:

```ts
// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only
```

Put it below a shebang line, if there is one. Files that take no comment (JSON, Markdown, images, the lockfile) are covered by [REUSE.toml](REUSE.toml). `reuse lint` checks the whole repository; `pipx run reuse lint` runs it locally.

## Security scans

`.github/workflows/security-scan.yml` runs Semgrep and Trivy on every pull request and fails it only on what the branch adds: a Semgrep finding, a committed secret, or a HIGH/CRITICAL vulnerability with a fix available. A daily scan covers the whole tree. A test must not hold a secret-shaped value: generate keys at run time instead.

## Pinning GitHub Actions

Pin every third-party action to a **full commit SHA** with a trailing version comment, never a moving tag:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A SHA can't be force-moved; a tag can. The `pinact` job checks it, and Dependabot rewrites the SHA and the comment on each upstream release.

## Reporting a vulnerability

Don't open a public issue or pull request for one: follow [SECURITY.md](SECURITY.md).
