# Changelog

All notable changes to Terragram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `terragram parse` types the Google Cloud IAM in a file as edges, the way it does AWS policies and Azure role assignments.
  `google_project_iam_member`, `_binding` and `_policy` (and the folder, organisation and billing account ones) give the principal an edge to
  "Any resource (*)" at the role's level; the same three on a storage bucket, Pub/Sub topic or subscription, Secret Manager secret, KMS key
  ring or key, BigQuery dataset, service account, Cloud Run service or Cloud Function give it an edge to the drawn resource they name (a
  target it cannot pin down, such as a name, a variable or a module output, is `unscoped` over any resource, and one on a resource that is not
  drawn, such as an Artifact Registry repository or a Spanner database, is an edge to any resource at the role's level, not nothing). A role is read by its name alone: `roles/owner`, `roles/editor` and
  `roles/cloudbuild.builds.editor` are `admin` (they can mint a key for or act as any service account), `roles/viewer` `read`; a
  predefined role by the last word of its name where that is unambiguous (`...Admin` is `admin`, `...Viewer` and `...Reader` are
  `read`, `...Writer`, `...Editor` and `...Publisher` are `write`); a custom role, a role that is a variable and every other
  predefined role (`secretAccessor`, `run.invoker`) are `unscoped`. `roles/iam.serviceAccountUser` and `serviceAccountTokenCreator` on a drawn service
  account are `runs-as` it when a drawn workload or account holds them, `admin` when a person, a service account that is not drawn, a federated identity
  or another principal does, `unscoped` when a group, a domain or the public does, and `unscoped` anywhere wider. A `condition` block marks the
  edge conditional only when its expression looks at the request or the resource: `true`, `1 == 1`, a comparison of literals, an `||` beside a literal
  `true` and a lower bound on `request.time` (a date that, once past, never narrows again) are not counted, and neither is an expression it cannot read in full; the edge keeps the level it gives without one. The principal is the drawn service account a
  member points at (`serviceAccount:${google_service_account.x.email}` or its `member` attribute); a member built by `concat()`, a `for` expression or a
  variable may be anyone and is an `unscoped` edge from "Another principal"; any other member starts at a stand-in
  node for its kind (a person, a group, a domain, a service account that is not drawn, `allUsers`, `allAuthenticatedUsers`, a
  federated identity, another principal) in fixed words, so no address, group or domain from the file reaches the model, and there are
  never more than eight such nodes. An authoritative policy that cannot be read, a file with more than 2000 grants and a grant
  that would draw more than 2000 edges add an unscoped edge from "Another principal" instead of drawing less, and so does a file whose grants cost more than a
  fixed budget of work (a policy document is read once however many policies use it, so 2000 policies of 1000 bindings are read in milliseconds). The
  access that is not a role is read as `unscoped` edges too: `google_storage_bucket_acl`, `_access_control`, `_default_object_acl`, `_default_object_access_control`,
  `_object_acl` and `_object_access_control` (from each `role_entity`, `entity` and `predefined_acl` they name, so `READER:allUsers` and `publicRead` are an edge from "Anyone on the internet"
  to the bucket), `google_bigquery_dataset_access` and the `access` blocks of a `google_bigquery_dataset` (`special_group`, `iam_member`, `user_by_email`, `group_by_email`, `domain` or an authorized view). A Cloud Run service,
  Cloud Function, GKE node pool or Compute instance that names a service account in `service_account`, `service_account_email` or its
  `service_account` block `runs-as` it. The AWS, Azure and Google Cloud grants of a file are all read, whichever cloud it goes to. The Action's
  "Access changes" list shows them like any other.
- `terragram parse` reads Google Cloud. A file of `google_*` resources parses to a model whose cloud is `gcp`, where it used to be
  refused as "none of the resources can be mapped". The new `project`, `kubernetes`, `virtual-machine` and `data-warehouse`
  kinds and a Google Cloud spec on the existing ones (`dns`, `load-balancer`, `containers`, `functions`, `queue`, `vnet`,
  `postgres`, `mysql`, `nosql`, `redis-cache`, `object-storage`, `static-site`, `key-vault`, `entra-id` for a service
  account, `monitoring`, `front-door`, `app-service`) map the common resources: projects, networks and subnetworks, instances, templates
  and instance groups, GKE clusters and node pools, Cloud Run, Cloud Functions, Cloud SQL, storage buckets (a bucket with a
  `website` block is a static site), Pub/Sub topics and subscriptions, Secret Manager secrets, KMS key rings and keys, BigQuery
  datasets, service accounts, load balancer pieces, DNS zones and Cloud Armor policies, plus the Google registry modules for them.
  The references between resources are the edges, as for AWS and Azure; the `project` every resource names is where it lives, not a
  wire to it. A file with resources of more than one cloud goes to the one of AWS and Azure most of them are on, a tie to Azure and then AWS as before; it is `gcp` only when it has no AWS or Azure resource or module in it, so a Google part of a mixed file is reported as left out of the Terraform when it has no component to build, never as "nothing left out".
  Google Cloud is read only: it is drawn (SVG, Mermaid, draw.io, the pull request diagram), explained ("This design targets Google Cloud
  in London (europe-west2)"), diffed and given a receipt, but no Terraform is generated for it. `emitTerraform` returns no files and
  no provider for it, the receipt's `plan` is empty and still verifies, `terragram generate --cloud gcp` is refused, and a model
  or a picture a managed model reads cannot choose it. `gcp` joins `azure` and `aws` in the `cloud` enum of the model and receipt
  schemas (`diagram.model/v1`, `diagram.receipt/v3`; `diagram.receipt/v2` keeps its two). The ids do not change: adding an enum value is additive, documents for the other two clouds are unchanged, and the field's `description` in both schemas tells a consumer with a closed list to accept `gcp`. The new kinds are not offered to a
  translator, since nothing it chose could be built. `GENERATED_CLOUDS` is the list of clouds a brief or a command can build for.
- `terragram parse` types a policy attached by the ARN of a well-known AWS managed policy instead of leaving it `unscoped`.
  A small bundled table (about 55 policies, dated, in `aws-managed-policies.ts`) gives each policy's level per service,
  read from its document in the AWS managed policy reference with the same rule that levels an action in an inline
  policy: `AdministratorAccess` and `PowerUserAccess` are `admin`, `ReadOnlyAccess`, `ViewOnlyAccess` and
  `SecurityAudit` are `read`, `AmazonS3ReadOnlyAccess` is `read` and `AmazonS3FullAccess` is `admin` on the
  drawn buckets, `AWSLambdaBasicExecutionRole` is `write` on logs. A managed policy is on every resource in the account,
  so each grant always ends at "Any resource (*)" at its level and also goes to each drawn resource of its service
  (not when none is drawn or there are more than the caps allow), the role's own node included. A service the picture
  cannot draw (`schemas`, `pi`, `wafv2`, `cognito-sync`, `eks-auth`) is a grant at "Any resource (*)", not left out. Any other ARN
  (another partition or account, a customer-managed or unlisted policy, a variable or a data source) is still
  `unscoped`. The table holds levels and service names only, never policy text.
- A typed edge whose policy statement has a `Condition` (or a `condition` block in an `aws_iam_policy_document`) is
  marked `conditional: true`: the access level is the same one the statement would grant, and the edge is never dropped
  or lowered because of it. It stays conditional only while every grant at its strongest level is, and then carries
  `unconditional`, the strongest level some grant gives with no condition ("admin, conditional (write unconditional)"),
  so an unconditional `s3:PutObject` is not hidden behind a conditional `s3:PutBucketPolicy`. A condition that is
  always true (`Null`, any `...IfExists` operator, a value that is only `*`) is not counted. The SVG, the
  pull request diagram, the plain-English description and the Action's "Access changes" list say "conditional", and a
  condition added or removed is a change of its own. `conditional` is an optional field on a model edge
  (`diagram.model/v1`), with the optional `unconditional` level beside it; the condition itself never reaches the model.
- The Action's pull request comment lists the access changes in the model: edges whose access type was added, removed,
  widened or narrowed, widest and unscoped first, as component names and levels only. A changed access type counts as a
  changed edge in the diagram and the table.
- `terragram parse` types the access edges of the Terraform it reads. An edge from a workload to the role or managed
  identity it runs as is `runs-as`; an edge from an identity to a resource its policy names is `read`, `write` or
  `admin`, by the strongest action the policy allows there; one the text cannot bound (a wildcard resource, `NotResource`,
  a policy that is a variable, file or template, an Azure role over a subscription or resource group, an unrecognised
  role) ends at an "Any resource (*)" node as `unscoped`. AWS policies are read from `jsonencode`, JSON heredocs,
  `aws_iam_policy_document` data sources, inline policies and attachments, and Azure from `azurerm_role_assignment`.
  Nothing is evaluated, and a policy's text never reaches the model: an edge carries a type and nothing else. The SVG
  writes the type on each line, the Action's pull request diagram labels it and counts a changed type as a change, and the
  plain-English description says it. `access` is an optional field on a model edge (`diagram.model/v1`).
- `terragram graph --format drawio` (and `renderGraphDrawio` in `terragram-engine/graph`) writes the estate as an
  uncompressed draw.io file that opens in diagrams.net: scopes, environments and module calls as containers, resources
  as cards inside them, references as connectors, laid out where the SVG puts them.
- `terragram generate --mermaid` reads Mermaid `architecture-beta` diagrams as well as flowcharts: services (matched by
  title; the `internet` icon is the outside world), nested groups (kept as members, reported), junctions (edges
  joined through them) and edges with sides and arrows. An icon outside Mermaid's built-ins makes a flagged generic
  component with a warning rather than a guess. Malformed input is refused with the line number.
- `terragram generate` and the Action warn when the Azure Terraform names a SKU the azurerm provider does not
  document (an App Service plan, Redis cache, storage account, PostgreSQL or MySQL flexible server, Key Vault,
  load balancer, Service Bus namespace, Front Door profile or Log Analytics workspace), or one the Azure
  retail price list has no price for in the plan's region. It reads a checked-in snapshot
  (`npm run refresh:azure-skus` rewrites it) and never calls Azure; a SKU or region the snapshot does not know is a
  warning that names the snapshot's date, never an error. The price list is not the Resource SKUs API, so it
  cannot see capacity or subscription restrictions.

### Changed

- `terragram graph` places every card, box and arrow by one fixed order: scope, environment name,
  module call, then the resource's Terraform address (then its root), so the same estate gives the same
  picture whatever order the document lists it in. Where the graph hashes or drops its addresses, the
  order falls back to type and ID as before. The ids in the Mermaid and the JSON view of an estate with
  several accounts are numbered differently; the drawing is the same.

## [0.2.0] - 2026-11-23

### Added

- `terragram graph` groups an estate by scope, then environment, then module call, and places
  findings by the graph's own Terraform addresses, told apart by environment and by the root a node
  was generated in. A diff shows a node whose environment or root changed. It reads infraharvest
  graph documents with node `environment`, `address`, `module_address` and `root`.
- `schemas/diagram-bundle-v1.schema.json`, the JSON Schema of the document the Action uploads
  (`diagram.bundle/v1`), so a control plane can validate what it receives. The Action's own tests check the
  document it sends against it.

### Changed

- The Action uploads the receipt bundle only from a push to the repository's default branch; pushes
  to other branches and tags skip the upload and say why.
- A DNS zone name may be written with its trailing dot, which the generated Terraform leaves out; a
  single-label name is refused with the reason.
- The Action and command-line bundles carry the MIT licence notices of the code they include.

### Fixed

- The Action uploads the receipt bundle only from a `push` run, as its README says. Before, any event except
  `pull_request` (a `workflow_run` that checked out a fork's head, a `workflow_dispatch`, a `schedule`) uploaded
  with the repository's identity; those runs now skip the upload and say why.
- Text from a model file stays text in the generated Terraform: `${` and `%{` in a quoted value are written as
  `${` and `%%{`, and control characters and newlines as escapes, so a `diagram.json` can no longer turn a
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
- A receipt with a missing or malformed plan, cloud, content hash, public key or signature is
  reported as a failure instead of stopping verification with an error.

## [0.1.0] - 2026-11-22

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
  `graph/v1` document as SVG, Mermaid or JSON, with scopes, environments and module calls as boxes, findings placed by Terraform address, a diff against an earlier
  document and finding overlays.
- The Action's `control-plane-url` now uploads the receipt bundle: it exchanges the job's GitHub
  identity token (`id-token: write`) for a repository-pinned token and sends the bundle to the
  control plane's `/api/v1/ingest/diagram`, failing the step with the control plane's reason when it
  is refused. New input `control-plane-audience` and output `snapshot-id`.

### Changed

- Names that end up in documents, generated code or a repository say `diagram`
  instead of the codename: the schema ids (`diagram.model/v1`,
  `diagram.receipt/v2`, `diagram.graph-view/v1`), the `ManagedBy = "diagram"`
  tag and the header comment in generated Terraform, and the Action's default
  model file (`diagram.json`), output directory (`_diagram/`), pull request
  comment marker and heading. `terragram verify` still accepts receipts that
  carry the `terragram.receipt/v1` and `terragram.receipt/v2` ids. The
  repository, packages and `terragram` command keep their names.
- Receipts are written as `diagram.receipt/v3`, whose content hash no longer depends on the machine or on how fields
  are joined: nodes, edges and attributes are sorted in code-unit order (not by the process locale, which could make
  two machines hash the same model differently) and the model and plan are serialised as one JSON document, so two
  different models cannot hash alike, and plan text cannot move between files. `verifyBundle` and `terragram verify`
  still verify `diagram.receipt/v2` receipts, and the older `terragram.receipt` ids, by the hash they were signed under;
  the receipt's schema id picks the hash, and an unknown id is refused. `schemas/receipt.v3.schema.json` is new and
  describes the hash; `receipt.v2.schema.json` is unchanged. The preview id and the variable order in generated
  Terraform also sort in code-unit order (no change to any generated file).
- `contentHashFor` takes the plan files and their order (and optionally the schema id) instead of the joined plan
  text, and `planText` is no longer exported.

### Removed

- The Next.js web app: the marketing site, the diagram workspace, account and
  billing, the API routes, the Supabase migrations, the Cypress suite and the
  deploy files (Dockerfile, Railway). The repository is now the TypeScript
  engine (`terragram-engine`), the `terragram` command line, the GitHub Action
  and the JSON Schemas, with their tests and CI.
- Engine code that only the app used: the workspace settings schema, the mode
  and format metadata, the share-link expiry check, and the compose suggestions.

[Unreleased]: https://github.com/hibiscus-ctrl/terragram/compare/cli-v0.2.0...main
[0.2.0]: https://github.com/hibiscus-ctrl/terragram/compare/cli-v0.1.0...cli-v0.2.0
[0.1.0]: https://github.com/hibiscus-ctrl/terragram/releases/tag/cli-v0.1.0
