# Changelog

All notable changes to Terragram are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The graph layout packs boxes and cards toward a 16:10 picture instead of laying the boxes side by side in one row: a 64-resource AWS estate in a few
  module and region boxes was about 10:1, and is now about 2:1, so its labels are readable at fit-to-view. The shape is an option, `aspect` (width over height,
  default 1.6, from 0.5 to 4; a value outside that is a `RangeError`) on `layoutGraphDocument`, `layoutGraphView`, `renderGraphSvg` and `renderGraphDrawio`, and `terragram graph --aspect`.
  Cards are 224 wide (were 172), so a type like `aws_s3_bucket_public_access_block` fits, and a longer one shows both its start and its end. Lines between boxes are
  routed through the gaps between cards. `diagram.graph-layout/v1` keeps its shape. The same input still gives the same layout in any order.
- `terragram-engine/graph` returns the layout of an estate as data: `layoutGraphDocument(doc, { base, findings, delta, title, maxNodes })`
  (or `layoutGraphView(view)`) gives a `diagram.graph-layout/v1` value with the boxes (account, environment, module call) and cards as
  rectangles, the references with the routes the picture draws, a `badges` object on each card and box (what changed against a base graph, and the findings by severity),
  the header and footer lines, and `cut`. These are the SVG's own coordinates, so a viewer that places them (the web app's React Flow canvas) draws the
  same picture; the SVG is now drawn from the layout, so the two cannot drift, and its bytes are unchanged. Every string is plain text with the control characters
  dropped and its length bounded, never markup. The same input gives the same layout in any order of the document. The schema is
  `schemas/graph-layout.v1.schema.json`, generated from the engine's zod schema.
- A graph of more than `MAX_GRAPH_NODES` (1000) resources is cut to its first ones in the picture's order, in every format (SVG, draw.io, Mermaid, JSON and the layout), and
  says so: `cut` in the view and the layout (the limit and how many cards and references were left out), and a line below the picture. Smaller graphs are unchanged.
  `terragram-engine` is now 0.2.0 (still private; not published or tagged).
- A node whose own grants reach the node itself is now marked as a way to widen its own access, instead of being dropped. A role whose inline
  policy allows `iam:PutRolePolicy`, `iam:AttachRolePolicy` or `iam:UpdateAssumeRolePolicy` (any IAM action that is not a read) on its own ARN, a
  managed policy that covers IAM attached to it, an Azure identity with an administrator role over its own id, and a Google Cloud service account with
  `roles/iam.serviceAccountTokenCreator` or an `...Admin` role on itself are `admin` over themselves; an action or role the reader cannot place is
  `unscoped`. Nothing is drawn from a node to itself, so the model carries it on the node: `selfAccess` (`admin` or `unscoped`) and `selfConditional`,
  both optional fields of `diagram.model/v1` (the id is unchanged). `explain` says "Can widen its own access: ...", the SVG card carries `self: admin`,
  the diagram's node says it, and the pull request's "Access changes" list has a line for it (added, widened, narrowed or removed) ranked beside the edges. Reads and
  writes on oneself, and `serviceAccountUser` on itself, are not marked. Only the level is kept, never the policy text.
  A literal ARN of a drawn role (`arn:aws:iam::123456789012:role/fn`, the account may be a reference) counts as that role, and a grant over `*`, a wildcard
  or unreadable ARN or a NotAction that can change IAM (and `AdministratorAccess`, or `IAMFullAccess` past the drawn-target cap, but not `PowerUserAccess`) marks
  the identity holding it too, so swapping an own-ARN grant for `*` no longer reads as access removed. A conditional access to itself carries what holds
  without the condition (`selfUnconditional`, an optional field of `diagram.model/v1`), worded like an edge's: `self: unscoped, conditional (admin unconditional)`.
  The pull request report ranks a rise in what holds without the condition as a widening, and a node whose only change is its own access says "can now
  widen its own access", not a change of kind.
- The bundled AWS managed policy table now holds the `iam:Get*`/`iam:List*` reads the published policy documents grant (`AWSLambda_ReadOnlyAccess` and
  `AWSLambda_FullAccess`, `AmazonDynamoDBReadOnlyAccess` and `FullAccess`, `AmazonCognitoPowerUser`, `CloudFrontFullAccess`, `CloudWatchFullAccess`,
  `AWSKeyManagementServicePowerUser`), so IAM shows as `read` where a policy grants it. Beside a conditional `iam:PassRole` row the read stays visible as the
  unconditional level. Reads of one named AWS service-linked role are still not counted.
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
- A virtual network's address space is checked before it is written into a plan. On Google Cloud, where the network's own firewall rule is sourced from its range, it has to be private: a block inside `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or the shared space `100.64.0.0/10`. On AWS and Azure those four are accepted and so is any other block as before, but `0.0.0.0/0` and a block wider than a `/8` are refused with the reason.
- `terragram generate`, the Action and `emitTerraform` write Terraform for Google Cloud, as they do for AWS and Azure. `--cloud gcp` is accepted, a brief that names
  Google Cloud or one of its services (GKE, Cloud Run, Cloud SQL, BigQuery, Pub/Sub, Firestore, Memorystore) picks it, a managed model and a picture can
  choose it, and a `gcp` model has a receipt whose plan is hashed like any other. The plan is on `hashicorp/google` `~> 8.12` (and `hashicorp/archive`
  or `google-beta` only in a plan that needs one, recorded in the receipt's bill of materials) and is written as the resources themselves, not as calls to
  the Google registry modules: the load balancer, Cloud Run and BigQuery modules hold the provider below its newest major, and each hides the arguments a
  scanner and a reviewer look for. Every plan has `project_id` (asked for, no default), `region` (`europe-west2`), `name_prefix` and `labels` variables, a
  `default_labels` provider setting, and one `google_project_service` that switches on exactly the APIs its components use; a resource that stands on nothing
  else waits for it. What each kind writes: `dns` a public zone with DNSSEC and query logging; `vnet` a custom-mode network, a subnetwork with flow logs and
  private access to Google APIs, a router with NAT, and an internal rule (sourced from the subnetwork's own range) and an IAP-only SSH rule; `virtual-machine` an instance with no public address,
  Shielded VM, OS Login, no project-wide SSH keys and its own service account; `kubernetes` a private GKE cluster with authorised networks, Workload Identity,
  Shielded Nodes, network policy, intranode visibility and a release channel, on a node pool whose service account holds only what nodes need; `containers` a
  Cloud Run service on its own service account; `functions` a second-generation Cloud Function packaged from a directory written beside the plan, its source in a
  private bucket; `object-storage` a bucket with uniform access, public access prevented, versions and access logs; `queue` a Pub/Sub topic, subscription and
  dead-letter topic; `key-vault` a Secret Manager secret under a Cloud KMS key that rotates every 90 days, with no value written; `entra-id` a service account;
  `monitoring` a log bucket retention, a notification channel and an alert policy; `postgres` and `mysql` a Cloud SQL instance with no public IP, TLS with a
  client certificate, backups and point-in-time recovery, audit flags, query insights and deletion protection, connected to as a service account through IAM
  database authentication, whose grants are bounded to the one instance by an IAM condition, so no password is created anywhere; `redis-cache` a Memorystore instance with AUTH and TLS; `nosql` a Firestore database;
  `data-warehouse` a BigQuery dataset; `project` a project with no default network and data-access audit logs. A database or a cache reaches its network through
  one private service connection per plan. Reading a Google plan back does not draw what the plan adds around a component, but only when a block is exactly what the generator writes and is tied to the component that uses it (a log bucket another bucket logs into, a source bucket a function is deployed from, the one `roles/storage.objectCreator` grant to Cloud Storage's own group on such a log bucket); a bucket that only carries the label or the name, or a grant to anyone else, is drawn. The Environment choice moves what costs money or blocks a `destroy` (availability, backup retention, deletion
  protection) and nothing that is security. The kinds only Google Cloud has (`project`, `kubernetes`, `virtual-machine`, `data-warehouse`) are now offered to a
  translator, and are reported as not buildable on AWS and Azure. `load-balancer` an external Application Load Balancer (an address, a URL map, a proxy and a rule on port 80) whose backends are what its
  edges add: a serverless network endpoint group for Cloud Run (whose ingress is then set to the balancer, and which may be invoked without an identity, as
  a balancer calls it with none), a Cloud Function or App Engine, a backend bucket for a site (served from its index document, the bucket kept private and
  read only by the balancer's service agent) or an internet endpoint group for another balancer; with nothing behind it, it redirects to a hostname it asks for.
  `front-door` Cloud Armor (the OWASP SQL injection, cross-site scripting and remote code execution rules, Log4Shell, and adaptive DDoS protection) and Cloud CDN in
  front of an application, as a balancer of its own whose resources are named `cdn-...` so reading a plan back tells it from a load balancer; in front of a load balancer it is that balancer's own: the policy and the cache go on its backends and no second front end or address is written, so there is no way to reach the origin around it. `app-service` App Engine
  standard on its own service account, deployed from a directory written beside the plan and read from its own source bucket only, HTTPS only, and closed to everything outside Google (`INGRESS_TRAFFIC_ALLOWED_INTERNAL_ONLY`) until a balancer fronts it, which opens it to the balancer and Google, or the model draws the internet straight to it, which makes it public and says so in the plan's header. `static-site` a private, versioned, logged bucket with an index
  document and an error page. A DNS zone wired to a balancer or a CDN publishes an A record for its address and gives it the zone's name over HTTPS: a Google-managed
  certificate, a TLS 1.2 floor, and port 80 redirecting to it. A front end no zone names answers on plain HTTP only, and the plan's header, `explain` and the feasibility
  check (which marks it as needing review) say so. A balancer and a CDN that send to the same target are one front end, so there is no way in around the policy, and
  a CDN's static site takes a Cloud Armor edge policy of its own (a backend bucket takes only that kind, which Google limits to address and region rules). The plan's header
  says what a balancer in front of Cloud Run or a function leaves open: the narrowest ingress setting Google has for an external balancer also admits callers inside the
  project's network, which reach the service around Cloud Armor. A site's private bucket is read by the balancer's service agent once the backend bucket that creates it
  exists, and destroying the plan leaves the default App Engine service's version in place (`noop_on_destroy`), which it cannot delete. The emit gate (`npm run validate:emit`, and the Generated Terraform job) now runs every brief and template for Google Cloud too,
  through `terraform fmt`, `init` and `validate`, `tflint` with the google ruleset (`--cloud=gcp` runs that cloud alone), `trivy` and `checkov`, with the exceptions
  in `scripts/scanner-skips.ts`, each with its reason.
  A plan with a `key-vault` puts every bucket (the log and source buckets the plan adds too), Pub/Sub topic and BigQuery dataset under that key, with one grant of
  `roles/cloudkms.cryptoKeyEncrypterDecrypter` to each service's own agent that is needed, and what is encrypted waits for it; the scanner exceptions for those three
  (`CKV_GCP_83`, `CKV_GCP_81`, `GCP-0066`) hold only in a plan with no key store. A GKE cluster removes the pool it is created with (`remove_default_node_pool`, `initial_node_count = 1`),
  admits only `gke_authorized_cidr` to its control plane (`gcp_public_cidrs_access_enabled = false`; the variable takes a `/24` or narrower, never a block that starts at `0`), and takes a
  `/28` control-plane range of its own, a validated variable per cluster, so two clusters in one plan never collide.
- The database versions the model offers are the ones still in support: PostgreSQL 15, 16, 17 and 18 and MySQL 8.4 (PostgreSQL 14, MySQL 8.0 and MySQL 5.7 are past end of life), on all three clouds.
  A model that still names an older one is emitted on the default version, and a file on one reads back without a version.
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
  Google Cloud is drawn (SVG, Mermaid, draw.io, the pull request diagram), explained ("This design targets Google Cloud
  in London (europe-west2)"), diffed and given a receipt, and Terraform is generated for it (see the next entry).
 `gcp` joins `azure` and `aws` in the `cloud` enum of the model and receipt
  schemas (`diagram.model/v1`, `diagram.receipt/v3`; `diagram.receipt/v2` keeps its two). The ids do not change: adding an enum value is additive, documents for the other two clouds are unchanged, and the field's `description` in both schemas tells a consumer with a closed list to accept `gcp`. `GENERATED_CLOUDS` is the list of clouds a brief or a command can build for.
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
- The generated-Terraform gate (`npm run validate:emit`) now also runs four Google Cloud plans (`scripts/emit-plans.ts`) beside the briefs and templates, so
  the kinds they never reached go through `terraform validate`, tflint, trivy and checkov: GKE, the project, the virtual machine, BigQuery, the CDN in front of
  a static site, and Pub/Sub topics, a dataset and buckets under the key store's key. A test holds that every Google Cloud kind is in one of them.

### Fixed

- Reading a plan back no longer hides a real Azure or AWS resource that only looks like the plan's own scaffolding. The Azure resource group and private
  DNS zone modules, the network an Azure plan adds when the model draws none, and the S3 log bucket of a bucket are hidden only when they are exactly
  what the generator writes (every input, no others, a name of the generator's shape) and a component of the file uses them, the way the Google Cloud
  scaffolding already is. A resource group of your own, a virtual network that is called `network`, a zone nothing reads, or a bucket that takes the
  access-log policy but is not the logging target of another is drawn, with its IAM edges.
- A Google Cloud Pub/Sub queue reads back as one node instead of two. The dead-letter topic the generator writes for a queue (its name and retention, the key
  store's key when there is one, no other attribute, given up on by the queue's own subscription and named like its topic) folds into the queue, and what is
  granted on it is granted on the queue. A topic of your own, whatever its name, a lookalike that differs in any way, or one no subscription gives up on is
  drawn as a queue of its own.
- Reading a plan back hides less of what an author wrote. A network whose `subnets` is a reference, a `merge()` or a `for` expression, or has no subnet in
  it, is drawn instead of passing as the plan's (only an object written out with every subnet exact is hidden); a private DNS zone is hidden only for the three
  domains the plan writes; and the resource group, network or zone is kept hidden only by a block the reader draws, not by an output, a local, a variable, a
  resource of a type no kind reads, or a string or heredoc that happens to spell `module.<name>`. The log and source buckets of a Google Cloud plan must also
  have the versioning, logging and lifecycle blocks the plan writes, each once.
- A Pub/Sub subscription that is not the one the plan writes for its queue is no longer absorbed into the queue: a push endpoint, a filter, a second
  consumer of the queue's topic or a subscription on a topic of your own is drawn as its own flagged node, listed as not translated (so it counts as not
  buildable, and a grant on it is a grant on it, not on the queue). A dead-letter topic is folded into its queue only when no subscription but the plan's own
  reads it or gives up on it.
- Two Google Cloud nodes of one kind no longer get the same service account id. The id was `sa-<name_prefix>-<slug>` cut to 30 characters, so `virtual-machine` and
  `virtual-machine-2` under a long prefix collided and the second apply failed with a 409. An id that fits is unchanged; one that does not keeps its first 23
  characters and ends in six characters of the SHA-256 of the whole, the same on every run. `name_prefix` now has a validation (1 to 20 lowercase letters, digits and
  hyphens, starting with a letter).
- A Google Cloud plan now refuses a label Google would refuse, at plan time. `var.labels` has a validation over every key and value (a key starts with a lowercase
  letter; keys and values hold lowercase letters, digits, hyphens and underscores and are at most 63 characters), where a bad label used to pass `terraform plan` and fail at apply.
- Importing a Mermaid `architecture-beta` diagram no longer takes quadratic or worse time on a declaration with a long run of whitespace (`service a` followed by
  4000 spaces and a character took 36 seconds). Each optional part of a declaration is read from its own leading whitespace, so the match is linear, and a line over 2000
  characters is refused with an error naming the line.
- The Google Cloud sandbox workflow runs only from `main`. A dispatch from another branch would have run that branch's `scripts/sandbox-gcp.sh` with the cloud token once the
  reviewers approved; now the first job fails with an error naming the ref, and the job that gets the token has `if: github.ref == 'refs/heads/main'`.
- The Google Cloud sandbox sweep deletes only what is named like a run's own (`ih-sbx-tg-<plan letter><4 hex digits>`, the shared network's `ih-sbx-tg-net-<4 hex digits>`), at the start of a
  name or after a hyphen or a slash, instead of anything with `ih-sbx-tg-` somewhere in its name. Its preflight now also stops the run when a service account of the project holds Service
  Account Token Creator, Service Account User (the signed-in account excepted), Project IAM Admin, Security Admin, Role Admin or Service Account Key Admin, besides Editor and Owner,
  and fails on an empty policy instead of passing it.
- The Google Cloud sandbox's check of the plans (`scripts/sandbox-gcp-validate.mjs`) now reads values, not only names. Before a plan is applied with a cloud token, a grant must be one of the
  exact roles the generator writes (held equal to `GCP_ROLES` by a test) of a role its type of grant carries, to a service account the plan creates, a service agent it names, Google's log
  delivery group, or `allUsers` as `roles/run.invoker` on Cloud Run; a virtual machine's `metadata` is the settings the generator writes (no `metadata_startup_script`, `startup-script`,
  `user-data` or `ssh-keys`); a container's image is the generator's (`GCP_IMAGES`) with no `command`, `args` or environment other than references to the plan's own resources under a
  name the generator writes; workloads run as a service account the plan creates; and a firewall or a control plane is not opened to `0.0.0.0/0`. A tampered plan is refused before Terraform runs.

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
