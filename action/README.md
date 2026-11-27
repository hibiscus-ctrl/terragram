# Diagram GitHub Action

Keeps a repository's Terraform in line with a diagram model file.

The model file (`diagram.json`, validated against `diagram.model/v1`) is the source of truth. On every run the Action regenerates the Terraform from it with the same engine the `terragram` CLI uses, then either fails when the committed Terraform differs (`check`) or writes the regenerated files (`write`). On a pull request it also posts one comment that shows what the change does to the model: a Mermaid diagram of the diff between the base and head versions of the model file, a summary table and the content hash of the receipt.

It runs from one committed bundle (`action/dist/index.mjs`) with no install step, makes no network call except to the GitHub API to post the comment (and to your control plane, only if you set `control-plane-url`), and never runs Terraform or any code from your repository.

## Use it

```yaml
name: Diagram

on:
  pull_request:
    paths:
      - diagram.json
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
          model: diagram.json
          terraform-dir: infra/
```

Pin both actions to a full commit SHA. A tag or branch can be moved; a SHA cannot.

`fetch-depth: 0` (or fetching the base commit some other way) is what lets the Action read the model as the pull request's base had it, with `git show <base_sha>:<model>`. Without the base commit the comment says so and shows no diagram; the check itself still runs.

### Writing instead of checking

`mode: write` writes the regenerated files to `terraform-dir` and leaves committing them to the workflow, so you choose how (a commit to the branch, a pull request, or an artifact):

```yaml
      - id: diagram
        uses: hibiscus-ctrl/terragram/action@<full commit SHA>
        with:
          mode: write
      - if: steps.diagram.outputs.changed == 'true'
        run: git diff --stat -- infra/
```

### Signing the receipt

Pass an Ed25519 private key (PKCS#8 PEM, or the PEM base64-encoded) from a secret:

```yaml
        with:
          signing-key: ${{ secrets.DIAGRAM_SIGNING_KEY }}
```

The key is masked in the log (`::add-mask::`, every line of it) and is used only to sign. The receipt carries the public key, and `terragram verify` checks it against a key you got from somewhere else:

```sh
terragram verify _diagram --key trusted-public-key.pem
```

Secrets are not available to workflows triggered from a fork's pull request, so those runs write an unsigned receipt.

### Uploading the bundle to a control plane

Set `control-plane-url` to keep each approved bundle (receipt, signature, model and plan) with a control plane that accepts it. The job needs **`permissions: id-token: write`**: the Action asks GitHub for the job's identity token and exchanges it, with no stored secret, for a short-lived token pinned to this repository.

```yaml
    permissions:
      contents: read
      id-token: write # GitHub's identity token, which proves which repository is sending
    steps:
      - uses: hibiscus-ctrl/terragram/action@<full commit SHA> # pin the version you reviewed
        with:
          signing-key: ${{ secrets.DIAGRAM_SIGNING_KEY }}
          control-plane-url: https://control-plane.example
```

What it does, in order: requests the identity token from `ACTIONS_ID_TOKEN_REQUEST_URL` for the audience `control-plane-audience` (default `infraharvest-api`); sends it in `X-GitHub-OIDC-Token` to `POST <url>/api/v1/session`, which answers a run token; then sends the bundle, gzip-compressed, to `POST <url>/api/v1/ingest/diagram` with that token as the bearer. The control plane checks the receipt against the engine (its schema, the content hash recomputed from the model and plan, and the signatures) and keeps it as an approval of the diagram for this repository and model path. The same bundle again is a replay, not a second approval.

- Both tokens are masked in the log the moment they are received, and neither is written anywhere.
- The address must be `https://` (a machine's own loopback excepted), with no credentials or query. Redirects are not followed, so a token is never sent to a place you did not name.
- A request that gets a 429 or a 5xx, or no answer within 30 seconds, is tried up to three times. Anything else fails the step with the control plane's own reason, and with what to fix for a missing `id-token: write`, a plan that does not keep uploads (402) or a token that is not a repository's (403).
- The upload happens before the drift check reports, so a drifted repository is still reported and still fails the step, and so does a failed upload. The bundle is uploaded only from a `push` to the repository's default branch (read from the event payload), and the step says so when it skips the upload. A push to another branch or a tag uploads nothing. A `pull_request` run (the model is not approved yet, and a fork's pull request gets no identity token anyway), a `workflow_dispatch`, a `schedule`, a `workflow_run` and every other event upload nothing: trigger the workflow from a push to the default branch, for instance with `on: push: branches: [main]`.
- The `snapshot-id` output holds the id the control plane kept the bundle under.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `model` | `diagram.json` | Path to the model file, relative to the workspace. Its `cloud` field picks `aws`, `azure` or `gcp`; without one, `azure`. For `gcp` the model is read, drawn, diffed and given a receipt, but no Terraform is generated, so there is nothing to compare or write. |
| `terraform-dir` | `infra/` | Directory holding the generated Terraform, relative to the workspace. |
| `mode` | `check` | `check` regenerates in memory and fails, printing a unified diff and one error annotation per file, when a generated file differs or is missing. `write` writes the regenerated files. Only the files Terragram generates are compared or written; anything else in the directory is left alone. Line endings are not compared. |
| `comment` | `true` | On a `pull_request` run, post or update one sticky comment (found by an HTML marker, and only if a bot wrote it). Ignored on other events. |
| `signing-key` | none | Ed25519 private key to sign the receipt with. |
| `control-plane-url` | none | Address of a control plane to upload the bundle to after the check; see above. Needs `id-token: write`. |
| `control-plane-audience` | `infraharvest-api` | The audience the identity token is requested for. The control plane must accept it. |
| `github-token` | `${{ github.token }}` | Token for the comment. It needs `pull-requests: write` and nothing else. |

## Outputs

| Output | |
| --- | --- |
| `changed` | `true` when `check` found drift, or `write` changed a file; otherwise `false`. |
| `receipt-path` | `_diagram/receipt.json`, relative to the workspace. |
| `content-hash` | The receipt's `sha256:` hash over the model and the generated Terraform. |
| `snapshot-id` | The id the control plane kept the uploaded bundle under; empty when nothing was uploaded. |

## The receipt bundle

Every run writes `_diagram/` in the workspace: `receipt.json`, `model.json` and `plan/` (the generated files), plus `receipt.json.sig` and `signing-key.pem` (the public half) when signed. That is the layout `terragram verify` reads. The directory is replaced on each run, and it is meant for `actions/upload-artifact`, not for committing (the receipt carries a timestamp), so add `_diagram/` to `.gitignore`.

## The pull-request comment

The comment holds, under a hidden marker so the next run updates it in place:

- a Mermaid flowchart of the model diff: added components and edges green, removed ones red and dashed, changed ones amber (a changed label, kind, attribute or review flag);
- a table of nodes and edges added, removed and changed;
- an "Access changes" list when edges carry an access type (`terragram parse` writes them from the Terraform's IAM): grants added, removed, widened or narrowed, widened and unscoped ones first, with "(conditional)" on a grant behind a condition, and the level it gives without one when that is lower. It names components and levels only, never a policy. For Google Cloud the grants are the `google_*_iam_member`, `_binding` and `_policy` resources: one that is not for a drawn service account starts at a stand-in for its kind of principal ("A person (user)", "A group", "Anyone on the internet (allUsers)"), never the address, and a project-level grant ends at "Any resource (*)";
- the number of feasibility warnings (components that cannot be built on the chosen cloud, or flagged for review), the Terraform files the model change alters, the files that differ from `terraform-dir`, and the receipt hash.

A model too large for Mermaid's limits is drawn as its changed part only, or not at all, with the table still there.

## Security

**Do not use this Action with `pull_request_target`, and it refuses to run under it.** That trigger runs in the context of the base repository with a token that can write, while the files it would read come from the pull request. Use `pull_request`. For a pull request from a fork, `pull_request` gives the job a read-only token and no secrets: the check still runs, the comment is skipped with a warning, and the receipt is unsigned.

- **Permissions.** `contents: read` to check out, `pull-requests: write` for the comment, and `id-token: write` only if you upload to a control plane. Nothing else is used.
- **Untrusted text.** The model file is part of the pull request, so its labels are untrusted. They are entity-encoded before they reach Mermaid or markdown, so a label cannot close the code fence, add markup or mention a user, and they never start a workflow command in the log.
- **Which comment is edited.** Only a comment authored by a bot account that carries the marker. A person who pastes the marker into their own comment does not make the Action edit it.
- **Paths.** `model` and `terraform-dir` must resolve inside the workspace; a path that leaves it is an error.
- **Nothing is executed.** The Action regenerates text; it does not run `terraform`, `init` or `plan`, and reads no provider credentials.
- **The bundle.** `action/dist/index.mjs` is not minified, so it can be read, and CI rebuilds it from the source and fails on any difference.

Report a vulnerability as described in the repository's [SECURITY.md](../SECURITY.md).

## Install the command line: `action/install-cli`

A separate action, `hibiscus-ctrl/terragram/action/install-cli@<full commit SHA>`, downloads a released `terragram`
command line for steps that call it. Inputs: `version` (for example `0.1.0`) and `sha256` (the hash of
`terragram-<version>.mjs` from the release's `SHA256SUMS`), both required, and `verify-attestation` (default `true`):
it runs `gh attestation verify` for the repository's `release-cli.yml` workflow and the tag `cli-v<version>`, and the
step fails when that fails. It needs Node 24 on the runner (run `actions/setup-node` first) and a Linux or macOS runner,
and puts a `terragram` wrapper on `PATH`. The file is fetched with curl from the release, and nothing is installed
when its SHA-256 differs from the one you pin. See the README's Install section for an example.
