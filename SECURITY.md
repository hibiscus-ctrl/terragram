# Security Policy

Terragram turns plain English, Mermaid flowcharts and architecture diagrams into reviewed Terraform through
one auditable internal model, and checks evidence receipts offline. This repository is the engine, the
command line and the GitHub Action. It runs no hosted service. The engine is deterministic by default: it
needs no model credentials, and any model call goes through a port the host binds. We take vulnerabilities in
the code that generates, signs and verifies what people apply to their infrastructure seriously.

## Reporting a vulnerability

**Please report privately — do not open a public issue or PR for a suspected vulnerability.**

Use GitHub's private vulnerability reporting for this repository
(<https://github.com/hibiscus-ctrl/terragram/security/advisories/new>) or email **security@terragram.dev** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if possible),
- affected component (engine, CLI, Action or schema) and version or commit.

We aim to acknowledge within **2 business days** and to agree a remediation timeline after triage. Please give us
a reasonable window to fix and release before any public disclosure (coordinated disclosure).

## Safe harbour

If you make a good-faith effort to follow this policy while researching a vulnerability, we will not pursue or
support legal action against you, and we will work with you to understand and resolve the issue quickly. Good
faith means: only test against your own repositories and workflows, do not access, modify or retain data that
is not yours, give us reasonable time to fix before public disclosure, and stop as soon as you have enough to
write the report. If you are unsure whether something is in bounds, ask first at <security@terragram.dev> —
asking is always in bounds.

This is not a bug-bounty programme; we pay no monetary rewards. We do credit researchers unless you would rather
we didn't.

## Scope

In scope for this repository:

- **The engine** (`packages/engine`): the Terraform/OpenTofu emitter (output that escapes quoting, injects
  configuration or leaks a value it was given), the HCL parser and Mermaid importer on hostile input, and the
  evidence receipt, its content hash and its signature handling.
- **The CLI** (`packages/cli`): path handling when it writes files, and `terragram verify`, which must report a
  receipt as verified only when the hash matches and the signature checks against a key from outside the bundle.
- **The GitHub Action** (`action/`): file access inside the workspace (symlinks, path traversal), the sticky pull
  request comment (hostile component labels, workflow-command injection through logs), handling of the
  `signing-key` input and the GitHub token, and the committed bundle in `action/dist` matching its source.
- **The JSON Schemas** (`schemas/`) where a schema accepts a document the engine would treat unsafely.

Out of scope: vulnerabilities in third-party dependencies with no effect on these components (report them
upstream), and Terraform you generate and then apply: review it, which is what the receipt is for.

## Handling of secrets (design notes)

- The engine never reads the environment, holds a key or mints a credential. A signing key reaches it only as a
  `Signer` the host passes in, and a model only as a `ModelClient`.
- The Action masks the `signing-key` input line by line, never writes it to a log, an output or the receipt bundle,
  and its error messages do not quote it. It refuses `pull_request_target` and only updates a comment a bot wrote.
- Receipts carry the signer's public key, but `terragram verify` never trusts it: the key must come from outside
  the bundle (`--key` or `--trust`), and an unsigned receipt does not verify.
- Tests generate their own keys at run time; no credential is committed.

Please report any deviation from the above.
