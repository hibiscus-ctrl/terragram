# Terragram GitHub Action

Keeps a repository's Terraform in line with a Terragram model file.

The model file (`terragram.json`, validated against `terragram.model/v1`) is the source of truth. On every run the Action regenerates the Terraform from it with the same engine the Terragram CLI uses, then either fails when the committed Terraform differs (`check`) or writes the regenerated files (`write`). On a pull request it also posts one comment that shows what the change does to the model: a Mermaid diagram of the diff between the base and head versions of the model file, a summary table and the content hash of the receipt.

It runs from one committed bundle (`action/dist/index.mjs`) with no install step, makes no network call except to the GitHub API to post the comment, and never runs Terraform or any code from your repository.

## Use it

```yaml
name: Terragram

on:
  pull_request:
    paths:
      - terragram.json
      - infra/**

permissions: {}

jobs:
  terraform-in-sync:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: write # the sticky comment; drop it, and set `comment: false`, to go without
    steps:
      - uses: actions/checkout@<full commit SHA> # pin the version you reviewed
        with:
          fetch-depth: 0 # the base commit must be present to diff the model
          persist-credentials: false

      - uses: hibiscus-ctrl/terragram/action@<full commit SHA> # pin the version you reviewed
        with:
          model: terragram.json
          terraform-dir: infra/
```

Pin both actions to a full commit SHA. A tag or branch can be moved; a SHA cannot.

`fetch-depth: 0` (or fetching the base commit some other way) is what lets the Action read the model as the pull request's base had it, with `git show <base_sha>:<model>`. Without the base commit the comment says so and shows no diagram; the check itself still runs.

### Writing instead of checking

`mode: write` writes the regenerated files to `terraform-dir` and leaves committing them to the workflow, so you choose how (a commit to the branch, a pull request, or an artifact):

```yaml
      - id: terragram
        uses: hibiscus-ctrl/terragram/action@<full commit SHA>
        with:
          mode: write
      - if: steps.terragram.outputs.changed == 'true'
        run: git diff --stat -- infra/
```

### Signing the receipt

Pass an Ed25519 private key (PKCS#8 PEM, or the PEM base64-encoded) from a secret:

```yaml
        with:
          signing-key: ${{ secrets.TERRAGRAM_SIGNING_KEY }}
```

The key is masked in the log (`::add-mask::`, every line of it) and is used only to sign. The receipt carries the public key, and `terragram verify` checks it against a key you got from somewhere else:

```sh
terragram verify _terragram --key trusted-public-key.pem
```

Secrets are not available to workflows triggered from a fork's pull request, so those runs write an unsigned receipt.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `model` | `terragram.json` | Path to the model file, relative to the workspace. Its `cloud` field picks `aws` or `azure`; without one, `azure`. |
| `terraform-dir` | `infra/` | Directory holding the generated Terraform, relative to the workspace. |
| `mode` | `check` | `check` regenerates in memory and fails, printing a unified diff and one error annotation per file, when a generated file differs or is missing. `write` writes the regenerated files. Only the files Terragram generates are compared or written; anything else in the directory is left alone. Line endings are not compared. |
| `comment` | `true` | On a `pull_request` run, post or update one sticky comment (found by an HTML marker, and only if a bot wrote it). Ignored on other events. |
| `signing-key` | none | Ed25519 private key to sign the receipt with. |
| `control-plane-url` | none | Accepted, but uploading receipts is not yet supported: nothing is sent, and the log says so. |
| `github-token` | `${{ github.token }}` | Token for the comment. It needs `pull-requests: write` and nothing else. |

## Outputs

| Output | |
| --- | --- |
| `changed` | `true` when `check` found drift, or `write` changed a file; otherwise `false`. |
| `receipt-path` | `_terragram/receipt.json`, relative to the workspace. |
| `content-hash` | The receipt's `sha256:` hash over the model and the generated Terraform. |

## The receipt bundle

Every run writes `_terragram/` in the workspace: `receipt.json`, `model.json` and `plan/` (the generated files), plus `receipt.json.sig` and `signing-key.pem` (the public half) when signed. That is the layout `terragram verify` reads. The directory is replaced on each run, and it is meant for `actions/upload-artifact`, not for committing (the receipt carries a timestamp), so add `_terragram/` to `.gitignore`.

## The pull-request comment

The comment holds, under a hidden marker so the next run updates it in place:

- a Mermaid flowchart of the model diff: added components and edges green, removed ones red and dashed, changed ones amber (a changed label, kind, attribute or review flag);
- a table of nodes and edges added, removed and changed;
- the number of feasibility warnings (components Terragram cannot build on the chosen cloud, or flagged for review), the Terraform files the model change alters, the files that differ from `terraform-dir`, and the receipt hash.

A model too large for Mermaid's limits is drawn as its changed part only, or not at all, with the table still there.

## Security

**Do not use this Action with `pull_request_target`, and it refuses to run under it.** That trigger runs in the context of the base repository with a token that can write, while the files it would read come from the pull request. Use `pull_request`. For a pull request from a fork, `pull_request` gives the job a read-only token and no secrets: the check still runs, the comment is skipped with a warning, and the receipt is unsigned.

- **Permissions.** `contents: read` to check out, `pull-requests: write` for the comment. Nothing else is used.
- **Untrusted text.** The model file is part of the pull request, so its labels are untrusted. They are entity-encoded before they reach Mermaid or markdown, so a label cannot close the code fence, add markup or mention a user, and they never start a workflow command in the log.
- **Which comment is edited.** Only a comment authored by a bot account that carries the marker. A person who pastes the marker into their own comment does not make the Action edit it.
- **Paths.** `model` and `terraform-dir` must resolve inside the workspace; a path that leaves it is an error.
- **Nothing is executed.** The Action regenerates text; it does not run `terraform`, `init` or `plan`, and reads no provider credentials.
- **The bundle.** `action/dist/index.mjs` is not minified, so it can be read, and CI rebuilds it from the source and fails on any difference.

Report a vulnerability as described in the repository's [SECURITY.md](../SECURITY.md).
