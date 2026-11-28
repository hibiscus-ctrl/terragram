// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type HclBlock, attributeOf, block, mapExpression, quote, quoteTemplate } from "./hcl.ts";
import type { ModelNode } from "./model.ts";

/**
 * What each kind emits on Google Cloud.
 *
 * Every kind is written as the resources a person would write by hand on the current
 * `hashicorp/google` provider, not as a call to a registry module. The maintained Google
 * modules would each hold the provider below its newest major (the load balancer, Cloud Run
 * and BigQuery ones do today), pull in `google-beta`, and hide the arguments a scanner and a
 * reviewer look for; a plan that is the resources has one provider and every hardening
 * argument in plain sight. `kinds.ts` binds these to the registry entry of the kind; this
 * file knows nothing of the registry beyond the shape of an emit context.
 *
 * The plan around them (provider, labels, the Google APIs the plan switches on, the private
 * service connection a database or cache reaches its network through) is `terraform.ts`'s.
 */

/** A variable a plan declares: `kinds.ts`'s `VariableSpec`, spelled here so this file imports nothing from the registry that imports it. */
type VariableSpec = {
  name: string;
  type: string;
  description?: string;
  default?: string;
  sensitive?: boolean;
};

/** What a kind asks of the plan around it. */
export type GcpPlan = {
  /** The Google APIs this kind needs enabled in the project. */
  api: (...services: string[]) => void;
  /** Private service access on this network, once however many ask. Returns the address of the connection to depend on. */
  privateServices: (networkId: string) => string;
  /** How many nodes of this node's kind the plan emitted before it: what makes a block it has to keep apart from its siblings' unique. */
  position: number;
};

const NAME_PREFIX: VariableSpec = {
  name: "name_prefix",
  type: "string",
  description: "Short prefix applied to every resource name.",
  default: quote("infra-prod"),
};

const NETWORK_ID: VariableSpec = {
  name: "network_id",
  type: "string",
  description: "VPC network the resources are placed in. Add a Virtual Network to the model to generate one.",
};
const SUBNETWORK_ID: VariableSpec = {
  name: "subnetwork_id",
  type: "string",
  description: "Subnetwork instances and clusters are placed in. Add a Virtual Network to the model to generate one.",
};

/** The labels variable and the project id are the plan's, declared by `terraform.ts`. */
export const GCP_LABELS: VariableSpec = {
  name: "labels",
  type: "map(string)",
  description:
    "Labels added to every resource — owner and cost_centre are what a reviewer asks for first. Merged over the plan's own labels, so a key set here wins. Keys and values are lowercase letters, digits, hyphens and underscores.",
  default: "{}",
};

type Attr = { key: string; value: string | undefined } | null | undefined;

/** What a kind is given to emit from: the registry's `EmitContext`, less what only the other clouds use. */
type GcpContext = {
  node: ModelNode;
  /** Unique Terraform block name for this node. */
  name: string;
  /** Unique kebab fragment for cloud resource names. */
  slug: string;
  /** A reviewer-confirmed attribute, else the field's fallback. */
  attr: (key: string) => string;
  /** The model's network, or null when it has none. */
  net: { vpcId: string; publicSubnets: string; privateSubnets: string } | null;
  gcp: GcpPlan;
};

/** `"<prefix>-${var.name_prefix}-<slug>"`, unique per node and readable in the plan. */
function cloudName(prefix: string, slug: string): string {
  return quoteTemplate`${prefix}-\${var.name_prefix}-${slug}`;
}

/** A service account id: 6 to 30 characters, ending in a letter or a digit. */
function accountId(slug: string): string {
  return `trim(substr(${quoteTemplate`sa-\${var.name_prefix}-${slug}`}, 0, 30), "-")`;
}

function production(c: Pick<GcpContext, "attr">): boolean {
  return c.attr("Environment") === "Production";
}

/** The network a consumer joins: the model's, else variables Terraform asks for. */
function netOrVars(net: GcpContext["net"]): { vpc: string; subnet: string; variables: VariableSpec[] } {
  if (net) return { vpc: net.vpcId, subnet: net.privateSubnets, variables: [] };
  return { vpc: "var.network_id", subnet: "var.subnetwork_id", variables: [NETWORK_ID, SUBNETWORK_ID] };
}

function serviceAccount(name: string, id: string, description: string): HclBlock {
  return block("resource", ["google_service_account", name], [
    { key: "account_id", value: accountId(id) },
    { key: "display_name", value: quote(description) },
  ]);
}

/** A grant of one project role to a service account the plan creates. */
function projectRole(name: string, role: string, account: string): HclBlock {
  return block("resource", ["google_project_iam_member", name], [
    { key: "project", value: "var.project_id" },
    { key: "role", value: quote(role) },
    { key: "member", value: `"serviceAccount:\${${account}.email}"` },
  ]);
}

/** The provider a resource that only the beta provider has names: `google_project_service_identity` is one. */
export const GCP_BETA_REF = "google-beta";

/**
 * What a bucket the plan adds around a component is for, and the name its bucket carries: the access-log
 * bucket of another bucket, the source a function is deployed from.
 */
const SCAFFOLD_BUCKETS = {
  "access-logs": /^"\$\{var\.project_id\}-logs-\$\{var\.name_prefix\}-[a-z0-9-]+"$/,
  "function-source": /^"\$\{var\.project_id\}-src-\$\{var\.name_prefix\}-[a-z0-9-]+"$/,
} as const;

/** Every expression in a block and the blocks nested in it. */
function expressionsIn(b: HclBlock): string[] {
  return [...b.attributes.map((a) => a.value), ...b.blocks.flatMap(expressionsIn)];
}

/**
 * A wait the plan adds itself: for the APIs it enables, and for the grant that lets a service agent use the key store's
 * key. Nothing else a block waits for is the plan's own.
 */
function isPlanWait(a: { key: string; value: string }): boolean {
  if (a.key !== "depends_on") return false;
  const items = a.value.replace(/^\s*\[|\]\s*$/g, "").split(",").map((i) => i.trim()).filter(Boolean);
  return items.length > 0 && items.every((i) => i === "google_project_service.enabled" || /^google_kms_crypto_key_iam_member\.[a-z0-9_]+$/.test(i));
}

/**
 * Whether a block carries these attributes and no others, each once, and no nested blocks unless `blocks` allows them
 * (a bucket's versioning and logging). The one thing it may carry besides is the
 * plan's own wait for the APIs it enables, which `terraform.ts` adds to a resource that stands on nothing else.
 */
function hasExactly(b: HclBlock, keys: readonly string[], blocks = false): boolean {
  const own = b.attributes.filter((a) => !isPlanWait(a));
  return (blocks || b.blocks.length === 0) && own.length === keys.length && keys.every((k) => own.filter((a) => a.key === k).length === 1);
}

const compact = (value: string | undefined): string => (value ?? "").replace(/\s+/g, "");

/**
 * Whether a bucket is exactly one the generator adds around a component, and is tied to it: its
 * attributes are the generator's and no others, its labels are the single purpose label, and the bucket
 * it serves names it (a log bucket as another bucket's `log_bucket`, a source bucket as the place a
 * function is deployed from). A bucket that differs in any way, or that nothing in the file uses that
 * way, is a bucket of the file's own and is drawn.
 */
function isScaffoldBucket(all: readonly HclBlock[], name: string): boolean {
  const b = all.find((x) => x.type === "resource" && x.labels[0] === "google_storage_bucket" && x.labels[1] === name);
  if (!b) return false;
  if (!hasExactly(b, ["name", "location", "storage_class", "uniform_bucket_level_access", "public_access_prevention", "force_destroy", "labels"], true)) return false;
  const v = (key: string) => attributeOf(b, key);
  if (v("location") !== "var.region" || v("storage_class") !== '"STANDARD"' || v("uniform_bucket_level_access") !== "true") return false;
  if (v("public_access_prevention") !== '"enforced"' || !/^(true|false)$/.test(v("force_destroy") ?? "")) return false;
  const purpose = (Object.keys(SCAFFOLD_BUCKETS) as Array<keyof typeof SCAFFOLD_BUCKETS>).find((p) => compact(v("labels")) === `{purpose="${p}"}`);
  if (!purpose || !SCAFFOLD_BUCKETS[purpose].test(v("name") ?? "")) return false;
  // Nothing but versions, a logging target, a lifecycle and, in a plan with a key store, that store's key: no website, no CORS.
  if (!b.blocks.every((c) => ["versioning", "logging", "lifecycle_rule", "encryption"].includes(c.type))) return false;
  const encryption = b.blocks.filter((c) => c.type === "encryption");
  if (encryption.length > 1) return false;
  const keyName = encryption[0] ? /^google_kms_crypto_key\.([a-z0-9_]+)\.id$/.exec(attributeOf(encryption[0], "default_kms_key_name") ?? "")?.[1] : undefined;
  if (encryption[0] && (!hasExactly(encryption[0], ["default_kms_key_name"]) || keyName === undefined)) return false;
  if (keyName !== undefined && !all.some((o) => o.type === "resource" && o.labels[0] === "google_kms_crypto_key" && o.labels[1] === keyName)) return false;
  const ref = `google_storage_bucket.${name}.name`;
  if (purpose === "access-logs") {
    return all.some(
      (o) =>
        o !== b &&
        o.type === "resource" &&
        o.labels[0] === "google_storage_bucket" &&
        o.blocks.some((c) => c.type === "logging" && attributeOf(c, "log_bucket") === ref),
    );
  }
  return all.some((o) => o.type === "resource" && o.labels[0] === "google_cloudfunctions2_function" && expressionsIn(o).includes(ref));
}

/**
 * Whether the private services range and connection the plan adds are what they look like: each exactly as
 * written, on the same network, naming each other, with a Cloud SQL or Memorystore instance on that network that
 * waits for the connection. Without that, they are a peering of the file's own and are drawn.
 */
function privateServicesInUse(all: readonly HclBlock[]): boolean {
  const resource = (type: string) => all.find((o) => o.type === "resource" && o.labels.length === 2 && o.labels[0] === type && o.labels[1] === "private_services");
  const address = resource("google_compute_global_address");
  const connection = resource("google_service_networking_connection");
  if (!address || !connection) return false;
  const exact =
    hasExactly(address, ["name", "purpose", "address_type", "prefix_length", "network"]) &&
    attributeOf(address, "purpose") === '"VPC_PEERING"' &&
    attributeOf(address, "address_type") === '"INTERNAL"' &&
    hasExactly(connection, ["network", "service", "reserved_peering_ranges", "deletion_policy"]) &&
    attributeOf(connection, "service") === '"servicenetworking.googleapis.com"' &&
    attributeOf(connection, "reserved_peering_ranges") === "[google_compute_global_address.private_services.name]";
  const network = compact(attributeOf(address, "network"));
  if (!exact || network === "" || compact(attributeOf(connection, "network")) !== network) return false;
  return all.some((o) => {
    if (o.type !== "resource" || !["google_sql_database_instance", "google_redis_instance"].includes(o.labels[0] ?? "")) return false;
    const on =
      o.labels[0] === "google_redis_instance"
        ? attributeOf(o, "authorized_network")
        : o.blocks.find((c) => c.type === "settings")?.blocks.find((c) => c.type === "ip_configuration")?.attributes.find((a) => a.key === "private_network")?.value;
    return compact(on) === network && compact(attributeOf(o, "depends_on")).includes("google_service_networking_connection.private_services");
  });
}

/** The bucket a `google_storage_bucket.<name>.name` reference names, when it is one. */
function bucketNamed(ref: string | undefined): string | undefined {
  return /^google_storage_bucket\.([a-z0-9_]+)\.name$/.exec(ref ?? "")?.[1];
}

/**
 * Whether a block is exactly what the plan adds around a component, rather than a component, a grant or a
 * bucket of the file's own: the API switch, the private service range and connection, a function's archive
 * and the object it uploads, a bucket's log and source buckets, and the one grant that lets Cloud Storage
 * write its usage logs. Each is matched on every attribute the generator writes, and on being tied to a
 * component that uses it; a near match is drawn, and a grant to anyone but Cloud Storage's own group is
 * never hidden.
 */
export function isGcpScaffold(b: HclBlock, all: readonly HclBlock[]): boolean {
  const type = b.labels[0];
  const name = b.labels[1];
  if (b.type === "data") {
    // The service agent a key's grant names: a lookup of nothing but the project's own agent, read by that one grant.
    const agentEmail = type === "google_storage_project_service_account" ? "email_address" : type === "google_bigquery_default_service_account" ? "email" : undefined;
    if (agentEmail !== undefined) {
      const member = `"serviceAccount:\${data.${type}.${name}.${agentEmail}}"`;
      return (
        b.labels.length === 2 &&
        hasExactly(b, []) &&
        all.some(
          (o) =>
            o.type === "resource" &&
            o.labels[0] === "google_kms_crypto_key_iam_member" &&
            hasExactly(o, ["crypto_key_id", "role", "member"]) &&
            attributeOf(o, "role") === '"roles/cloudkms.cryptoKeyEncrypterDecrypter"' &&
            attributeOf(o, "member") === member,
        )
      );
    }
    return (
      type === "archive_file" &&
      b.labels.length === 2 &&
      hasExactly(b, ["type", "source_dir", "output_path"]) &&
      attributeOf(b, "type") === '"zip"' &&
      /^"\$\{path\.module\}\/src\/[a-z0-9-]+"$/.test(attributeOf(b, "source_dir") ?? "") &&
      /^"\$\{path\.module\}\/\.terraform\/[a-z0-9-]+\.zip"$/.test(attributeOf(b, "output_path") ?? "")
    );
  }
  if (b.type !== "resource" || b.labels.length !== 2 || name === undefined) return false;
  switch (type) {
    case "google_project_service": {
      // The plan's one switch for the APIs its components use, in the project it works in: the provider's own, or
      // a project the file creates. A literal list of Google API names and nothing else, so it enables only APIs.
      const project = attributeOf(b, "project");
      const created = /^google_project\.([a-z0-9_]+)\.project_id$/.exec(project ?? "")?.[1];
      return (
        name === "enabled" &&
        hasExactly(b, project === undefined ? ["for_each", "service", "disable_on_destroy"] : ["for_each", "project", "service", "disable_on_destroy"]) &&
        (project === undefined || (created !== undefined && all.some((o) => o.type === "resource" && o.labels[0] === "google_project" && o.labels[1] === created))) &&
        attributeOf(b, "service") === "each.value" &&
        attributeOf(b, "disable_on_destroy") === "false" &&
        /^toset\(\["[a-z0-9.-]+\.googleapis\.com"(,"[a-z0-9.-]+\.googleapis\.com")*\]\)$/.test(compact(attributeOf(b, "for_each")))
      );
    }
    case "google_compute_global_address":
      return (
        name === "private_services" &&
        hasExactly(b, ["name", "purpose", "address_type", "prefix_length", "network"]) &&
        attributeOf(b, "purpose") === '"VPC_PEERING"' &&
        attributeOf(b, "address_type") === '"INTERNAL"' &&
        privateServicesInUse(all)
      );
    case "google_service_networking_connection":
      return (
        name === "private_services" &&
        hasExactly(b, ["network", "service", "reserved_peering_ranges", "deletion_policy"]) &&
        attributeOf(b, "service") === '"servicenetworking.googleapis.com"' &&
        attributeOf(b, "reserved_peering_ranges") === "[google_compute_global_address.private_services.name]" &&
        privateServicesInUse(all)
      );
    case "google_storage_bucket":
      return isScaffoldBucket(all, name);
    case "google_storage_bucket_object": {
      const bucket = bucketNamed(attributeOf(b, "bucket"));
      return (
        hasExactly(b, ["name", "bucket", "source"]) &&
        bucket !== undefined &&
        isScaffoldBucket(all, bucket) &&
        /^"\$\{data\.archive_file\.[a-z0-9_]+\.output_md5\}\.zip"$/.test(attributeOf(b, "name") ?? "") &&
        /^data\.archive_file\.[a-z0-9_]+\.output_path$/.test(attributeOf(b, "source") ?? "")
      );
    }
    case "google_storage_bucket_iam_member": {
      const bucket = bucketNamed(attributeOf(b, "bucket"));
      return (
        hasExactly(b, ["bucket", "role", "member"]) &&
        attributeOf(b, "role") === '"roles/storage.objectCreator"' &&
        attributeOf(b, "member") === '"group:cloud-storage-analytics@google.com"' &&
        bucket !== undefined &&
        isScaffoldBucket(all, bucket)
      );
    }
    default:
      return false;
  }
}

/* ----------------------------------------------------------------- buckets -- */

/**
 * A storage bucket the way a reviewer would harden one: uniform bucket-level access,
 * public access prevented outright, versions kept, and every request logged to a bucket
 * of its own. The log bucket is the one that is not logged: logging it would need a
 * further bucket, and that one another, without end.
 */
function bucketWithLogs(c: GcpContext, opts: { prefix: string; purpose?: string }): { bucket: HclBlock; blocks: HclBlock[] } {
  const logs = `${c.name}_logs`;
  const purpose = opts.purpose ? [{ key: "labels", value: mapExpression([{ key: "purpose", value: quote(opts.purpose) }]) }] : [];
  const bucket = block("resource", ["google_storage_bucket", c.name], [
    { key: "name", value: `"\${var.project_id}-${opts.prefix}-\${var.name_prefix}-${c.slug}"` },
    { key: "location", value: "var.region" },
    { key: "storage_class", value: quote("STANDARD") },
    { key: "uniform_bucket_level_access", value: "true" },
    { key: "public_access_prevention", value: quote("enforced") },
    { key: "force_destroy", value: production(c) ? "false" : "true" },
    ...purpose,
  ], [
    block("versioning", [], [{ key: "enabled", value: "true" }]),
    block("logging", [], [
      { key: "log_bucket", value: `google_storage_bucket.${logs}.name` },
      { key: "log_object_prefix", value: quote("access/") },
    ]),
  ]);
  const logBucket = block("resource", ["google_storage_bucket", logs], [
    { key: "name", value: `"\${var.project_id}-logs-\${var.name_prefix}-${c.slug}"` },
    { key: "location", value: "var.region" },
    { key: "storage_class", value: quote("STANDARD") },
    { key: "uniform_bucket_level_access", value: "true" },
    { key: "public_access_prevention", value: quote("enforced") },
    { key: "force_destroy", value: "true" },
    { key: "labels", value: mapExpression([{ key: "purpose", value: quote("access-logs") }]) },
  ], [
    block("versioning", [], [{ key: "enabled", value: "true" }]),
    block("lifecycle_rule", [], [], [
      block("condition", [], [{ key: "age", value: "365" }]),
      block("action", [], [{ key: "type", value: quote("Delete") }]),
    ]),
  ]);
  // Storage delivers usage logs as this Google group, which has to be allowed to write them.
  const grant = block("resource", ["google_storage_bucket_iam_member", `${logs}_delivery`], [
    { key: "bucket", value: `google_storage_bucket.${logs}.name` },
    { key: "role", value: quote("roles/storage.objectCreator") },
    { key: "member", value: quote("group:cloud-storage-analytics@google.com") },
  ]);
  return { bucket, blocks: [bucket, logBucket, grant] };
}

/* ----------------------------------------------------------------- the kinds -- */

/** What an emit hands back: the blocks, which one others refer to, and what the plan gains. */
type GcpEmit = {
  blocks: HclBlock[];
  referent?: number;
  consumer?: number;
  outputs?: Array<{ name: string; value: string }>;
  variables?: VariableSpec[];
  files?: Array<{ name: string; content: string }>;
};

/** Cloud SQL's two engines share almost everything; this is what differs. */
type SqlEngine = {
  version: string;
  iamFlag: string;
  userName: (account: string) => string;
  flags: Array<[string, string]>;
  backup: Attr[];
};

const POSTGRES: Omit<SqlEngine, "version"> = {
  iamFlag: "cloudsql.iam_authentication",
  userName: (account) => `trimsuffix(${account}.email, ".gserviceaccount.com")`,
  flags: [
    ["log_checkpoints", "on"],
    ["log_connections", "on"],
    ["log_disconnections", "on"],
    ["log_lock_waits", "on"],
    ["log_min_messages", "error"],
    ["log_temp_files", "0"],
    ["log_min_duration_statement", "-1"],
    ["log_min_error_statement", "error"],
    ["log_hostname", "on"],
    ["log_duration", "on"],
    ["log_statement", "ddl"],
    ["cloudsql.enable_pgaudit", "on"],
    ["pgaudit.log", "ddl,write"],
  ],
  backup: [{ key: "point_in_time_recovery_enabled", value: "true" }],
};

const MYSQL: Omit<SqlEngine, "version"> = {
  iamFlag: "cloudsql_iam_authentication",
  userName: (account) => `split("@", ${account}.email)[0]`,
  flags: [
    ["local_infile", "off"],
    ["skip_show_database", "on"],
  ],
  backup: [{ key: "binary_log_enabled", value: "true" }],
};

/**
 * A Cloud SQL instance on a private address, with no public IP, TLS required, backups
 * (point-in-time recovery too), query insights and the audit flags a reviewer asks for.
 * No password is created anywhere: the application connects as a service account the plan
 * makes, through IAM database authentication.
 */
function sqlInstance(c: GcpContext, engine: SqlEngine, prefix: string): GcpEmit {
  c.gcp.api("sqladmin.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com");
  const { vpc, variables } = netOrVars(c.net);
  const connection = c.gcp.privateServices(vpc);
  const prod = production(c);
  const instance = block("resource", ["google_sql_database_instance", c.name], [
    { key: "name", value: cloudName(prefix, c.slug) },
    { key: "database_version", value: quote(engine.version) },
    { key: "region", value: "var.region" },
    { key: "deletion_protection", value: "true" },
  ], [
    block("settings", [], [
      { key: "tier", value: quote(prod ? "db-custom-2-7680" : "db-custom-1-3840") },
      { key: "edition", value: quote("ENTERPRISE") },
      { key: "availability_type", value: quote(prod ? "REGIONAL" : "ZONAL") },
      { key: "disk_type", value: quote("PD_SSD") },
      { key: "disk_autoresize", value: "true" },
      { key: "deletion_protection_enabled", value: "true" },
    ], [
      block("ip_configuration", [], [
        { key: "ipv4_enabled", value: "false" },
        { key: "private_network", value: vpc },
        { key: "ssl_mode", value: quote("TRUSTED_CLIENT_CERTIFICATE_REQUIRED") },
      ]),
      block("backup_configuration", [], [
        { key: "enabled", value: "true" },
        { key: "start_time", value: quote("03:00") },
        ...engine.backup,
      ], [
        block("backup_retention_settings", [], [{ key: "retained_backups", value: prod ? "35" : "7" }]),
      ]),
      block("insights_config", [], [{ key: "query_insights_enabled", value: "true" }]),
      block("maintenance_window", [], [
        { key: "day", value: "7" },
        { key: "hour", value: "3" },
      ]),
      block("database_flags", [], [
        { key: "name", value: quote(engine.iamFlag) },
        { key: "value", value: quote("on") },
      ]),
      ...engine.flags.map(([name, value]) =>
        block("database_flags", [], [
          { key: "name", value: quote(name) },
          { key: "value", value: quote(value) },
        ]),
      ),
    ]),
  ]);
  instance.attributes.push({ key: "depends_on", value: `[${connection}]` });
  const appAccount = `${c.name}_app`;
  const database = block("resource", ["google_sql_database", c.name], [
    { key: "name", value: quote("app") },
    { key: "instance", value: `google_sql_database_instance.${c.name}.name` },
  ]);
  const user = block("resource", ["google_sql_user", c.name], [
    { key: "name", value: engine.userName(`google_service_account.${appAccount}`) },
    { key: "instance", value: `google_sql_database_instance.${c.name}.name` },
    { key: "type", value: quote("CLOUD_IAM_SERVICE_ACCOUNT") },
  ]);
  return {
    blocks: [
      instance,
      serviceAccount(appAccount, `${c.slug}-app`, `Connects to the ${c.slug} database with IAM authentication`),
      projectRole(`${c.name}_app_instance_user`, "roles/cloudsql.instanceUser", `google_service_account.${appAccount}`),
      projectRole(`${c.name}_app_client`, "roles/cloudsql.client", `google_service_account.${appAccount}`),
      database,
      user,
    ],
    variables: [NAME_PREFIX, ...variables],
    outputs: [
      { name: `${c.name}_private_ip`, value: `google_sql_database_instance.${c.name}.private_ip_address` },
      { name: `${c.name}_app_account`, value: `google_service_account.${appAccount}.email` },
    ],
  };
}

/** Cloud SQL's names for the majors the model offers. */
const PG_DATABASE_VERSION: Record<string, string> = {
  "PostgreSQL 18": "POSTGRES_18",
  "PostgreSQL 17": "POSTGRES_17",
  "PostgreSQL 16": "POSTGRES_16",
  "PostgreSQL 15": "POSTGRES_15",
};
const MYSQL_DATABASE_VERSION: Record<string, string> = {
  "MySQL 8.4": "MYSQL_8_4",
};

/** A Redis tier the model's Cache SKU labels choose between. */
const REDIS_TIER: Record<string, { tier: string; size: string }> = {
  "Basic (C0)": { tier: "BASIC", size: "1" },
  "Standard (C1)": { tier: "STANDARD_HA", size: "1" },
  "Premium (P1)": { tier: "STANDARD_HA", size: "5" },
};

export function redisSkuFrom(tier: string | undefined, size: string | undefined): string | undefined {
  return Object.entries(REDIS_TIER).find(([, v]) => v.tier === tier && v.size === size)?.[0];
}

/** Cloud Run sizes: the model's three, in the CPU and memory limits Cloud Run takes. */
const RUN_SIZE: Record<string, { cpu: string; memory: string }> = {
  "Small (0.5 vCPU)": { cpu: "500m", memory: "512Mi" },
  "Medium (1 vCPU)": { cpu: "1000m", memory: "1Gi" },
  "Large (2 vCPU)": { cpu: "2000m", memory: "2Gi" },
};

export function runSizeFrom(cpu: string | undefined): string | undefined {
  return Object.entries(RUN_SIZE).find(([, v]) => v.cpu === cpu)?.[0];
}

/** What each runtime is called by Cloud Functions, its entry point, and the file that holds it. */
type FunctionRuntime = { runtime: string; entry: string; file: string; stub: string; extra?: Array<{ file: string; stub: string }> };
const FUNCTION_RUNTIME: Record<string, FunctionRuntime> = {
  "Node.js 22": {
    runtime: "nodejs22",
    entry: "handler",
    file: "index.js",
    stub: [
      "// Placeholder handler — replace with your function's code.",
      "// An HTTP function is the one exported under the entry point named in main.tf.",
      "exports.handler = (req, res) => {",
      "  res.status(200).json({ ok: true, message: \"Replace this placeholder with your function.\" });",
      "};",
      "",
    ].join("\n"),
    extra: [{ file: "package.json", stub: `${JSON.stringify({ name: "function", version: "1.0.0", main: "index.js" }, null, 2)}\n` }],
  },
  "Python 3.12": {
    runtime: "python312",
    entry: "handler",
    file: "main.py",
    stub: [
      "\"\"\"Placeholder handler — replace with your function's code.\"\"\"",
      "",
      "import functions_framework",
      "",
      "",
      "@functions_framework.http",
      "def handler(request):",
      "    return {\"ok\": True, \"message\": \"Replace this placeholder with your function.\"}",
      "",
    ].join("\n"),
    extra: [{ file: "requirements.txt", stub: "functions-framework==3.*\n" }],
  },
  "Java 21": {
    runtime: "java21",
    entry: "example.Handler",
    file: "src/main/java/example/Handler.java",
    stub: [
      "package example;",
      "",
      "// Placeholder handler. Add the Functions Framework dependency to a pom.xml beside this",
      "// source, then deploy; the source is here so the plan can package a directory.",
      "import com.google.cloud.functions.HttpFunction;",
      "import com.google.cloud.functions.HttpRequest;",
      "import com.google.cloud.functions.HttpResponse;",
      "",
      "public class Handler implements HttpFunction {",
      "  @Override",
      "  public void service(HttpRequest request, HttpResponse response) throws java.io.IOException {",
      "    response.getWriter().write(\"ok\");",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
};

export function functionRuntimeFrom(runtime: string | undefined): string | undefined {
  return Object.entries(FUNCTION_RUNTIME).find(([, v]) => v.runtime === runtime)?.[0];
}

/** The tables and helpers `kinds.ts` binds to the registry. */
export const GCP = {
  /** A public DNS zone with DNSSEC on and query logging. */
  dns: {
    emit: (c: GcpContext) => {
      c.gcp.api("dns.googleapis.com");
      return {
        blocks: [
          block("resource", ["google_dns_managed_zone", c.name], [
            { key: "name", value: cloudName("zone", c.slug) },
            { key: "dns_name", value: quoteTemplate`${c.attr("Zone name")}.` },
            { key: "visibility", value: quote("public") },
            { key: "force_destroy", value: "false" },
          ], [
            block("dnssec_config", [], [{ key: "state", value: quote("on") }]),
            block("cloud_logging_config", [], [{ key: "enable_logging", value: "true" }]),
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_name_servers`, value: `google_dns_managed_zone.${c.name}.name_servers` }],
      };
    },
  },

  /**
   * A custom-mode network: one regional subnetwork with flow logs and private access to
   * Google APIs, a router with NAT so private workloads reach the internet and are not
   * reachable from it, and the two ingress rules a private network needs.
   */
  network: {
    emit: (c: GcpContext) => {
      c.gcp.api("compute.googleapis.com");
      const cidr = quote(c.attr("Address space"));
      const subnet = `cidrsubnet(${cidr}, 8, 1)`;
      return {
        blocks: [
          block("resource", ["google_compute_network", c.name], [
            { key: "name", value: cloudName("vpc", c.slug) },
            { key: "auto_create_subnetworks", value: "false" },
            { key: "routing_mode", value: quote("REGIONAL") },
          ]),
          block("resource", ["google_compute_subnetwork", c.name], [
            { key: "name", value: cloudName("subnet", c.slug) },
            { key: "network", value: `google_compute_network.${c.name}.id` },
            { key: "region", value: "var.region" },
            { key: "ip_cidr_range", value: subnet },
            { key: "private_ip_google_access", value: "true" },
          ], [
            block("log_config", [], [
              { key: "aggregation_interval", value: quote("INTERVAL_5_SEC") },
              { key: "flow_sampling", value: "0.5" },
              { key: "metadata", value: quote("INCLUDE_ALL_METADATA") },
            ]),
          ]),
          block("resource", ["google_compute_router", c.name], [
            { key: "name", value: cloudName("router", c.slug) },
            { key: "network", value: `google_compute_network.${c.name}.id` },
            { key: "region", value: "var.region" },
          ]),
          block("resource", ["google_compute_router_nat", c.name], [
            { key: "name", value: cloudName("nat", c.slug) },
            { key: "router", value: `google_compute_router.${c.name}.name` },
            { key: "region", value: "var.region" },
            { key: "nat_ip_allocate_option", value: quote("AUTO_ONLY") },
            { key: "source_subnetwork_ip_ranges_to_nat", value: quote("ALL_SUBNETWORKS_ALL_IP_RANGES") },
          ], [
            block("log_config", [], [
              { key: "enable", value: "true" },
              { key: "filter", value: quote("ERRORS_ONLY") },
            ]),
          ]),
          // What the network's own members say to each other.
          block("resource", ["google_compute_firewall", `${c.name}_internal`], [
            { key: "name", value: cloudName("allow-internal", c.slug) },
            { key: "network", value: `google_compute_network.${c.name}.name` },
            { key: "direction", value: quote("INGRESS") },
            // The subnetwork's own range, as the plan wrote it: whatever else a reviewer edits, this is never wider than it.
            { key: "source_ranges", value: `[google_compute_subnetwork.${c.name}.ip_cidr_range]` },
          ], [
            block("allow", [], [{ key: "protocol", value: quote("tcp") }]),
            block("allow", [], [{ key: "protocol", value: quote("udp") }]),
            block("allow", [], [{ key: "protocol", value: quote("icmp") }]),
            block("log_config", [], [{ key: "metadata", value: quote("INCLUDE_ALL_METADATA") }]),
          ]),
          // SSH only through Identity-Aware Proxy, whose range is Google's: no instance needs an address of its own.
          block("resource", ["google_compute_firewall", `${c.name}_iap_ssh`], [
            { key: "name", value: cloudName("allow-iap-ssh", c.slug) },
            { key: "network", value: `google_compute_network.${c.name}.name` },
            { key: "direction", value: quote("INGRESS") },
            { key: "source_ranges", value: `["35.235.240.0/20"]` },
          ], [
            block("allow", [], [
              { key: "protocol", value: quote("tcp") },
              { key: "ports", value: `["22"]` },
            ]),
            block("log_config", [], [{ key: "metadata", value: quote("INCLUDE_ALL_METADATA") }]),
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_id`, value: `google_compute_network.${c.name}.id` }],
      };
    },
    refs: (name: string) => ({
      vpcId: `google_compute_network.${name}.id`,
      publicSubnets: `google_compute_subnetwork.${name}.id`,
      privateSubnets: `google_compute_subnetwork.${name}.id`,
    }),
  },

  /** An instance with no public address, Shielded VM, OS Login, no project-wide SSH keys and its own service account. */
  virtualMachine: {
    emit: (c: GcpContext) => {
      c.gcp.api("compute.googleapis.com");
      const { subnet, variables } = netOrVars(c.net);
      return {
        blocks: [
          block("resource", ["google_compute_instance", c.name], [
            { key: "name", value: cloudName("vm", c.slug) },
            { key: "machine_type", value: quote("e2-medium") },
            { key: "zone", value: `"\${var.region}-a"` },
            { key: "can_ip_forward", value: "false" },
            {
              key: "metadata",
              value: mapExpression([
                { key: "block-project-ssh-keys", value: quote("true") },
                { key: "enable-oslogin", value: quote("TRUE") },
                { key: "serial-port-enable", value: quote("false") },
              ]),
            },
          ], [
            block("boot_disk", [], [], [
              block("initialize_params", [], [
                { key: "image", value: quote("debian-cloud/debian-12") },
                { key: "size", value: "20" },
                { key: "type", value: quote("pd-balanced") },
              ]),
            ]),
            block("network_interface", [], [{ key: "subnetwork", value: subnet }]),
            block("service_account", [], [
              { key: "email", value: `google_service_account.${c.name}.email` },
              { key: "scopes", value: `["cloud-platform"]` },
            ]),
            block("shielded_instance_config", [], [
              { key: "enable_secure_boot", value: "true" },
              { key: "enable_vtpm", value: "true" },
              { key: "enable_integrity_monitoring", value: "true" },
            ]),
          ]),
          serviceAccount(c.name, c.slug, `Runs the ${c.slug} instance`),
          projectRole(`${c.name}_log_writer`, "roles/logging.logWriter", `google_service_account.${c.name}`),
          projectRole(`${c.name}_metric_writer`, "roles/monitoring.metricWriter", `google_service_account.${c.name}`),
        ],
        variables: [NAME_PREFIX, ...variables],
        outputs: [{ name: `${c.name}_internal_ip`, value: `google_compute_instance.${c.name}.network_interface[0].network_ip` }],
      };
    },
  },

  /**
   * A private, regional-in-production GKE cluster on a node pool of its own: private nodes,
   * authorised networks only, Workload Identity, Shielded Nodes, network policy and a
   * release channel, with nodes that run as a service account holding only what they need.
   */
  kubernetes: {
    emit: (c: GcpContext) => {
      c.gcp.api("container.googleapis.com", "compute.googleapis.com");
      const { vpc, subnet, variables } = netOrVars(c.net);
      const prod = production(c);
      const location = prod ? "var.region" : `"\${var.region}-a"`;
      const nodes = `${c.name}_nodes`;
      // Each cluster's control plane takes a /28 of its own, so two clusters in one plan never ask for the same range.
      const master = `${c.name}_master_cidr`;
      return {
        blocks: [
          block("resource", ["google_container_cluster", c.name], [
            { key: "name", value: cloudName("gke", c.slug) },
            { key: "location", value: location },
            { key: "network", value: vpc },
            { key: "subnetwork", value: subnet },
            { key: "networking_mode", value: quote("VPC_NATIVE") },
            // The node pool below is the only one: the pool a cluster is created with is removed, as the provider documents.
            { key: "remove_default_node_pool", value: "true" },
            { key: "initial_node_count", value: "1" },
            { key: "enable_shielded_nodes", value: "true" },
            { key: "enable_intranode_visibility", value: "true" },
            { key: "enable_legacy_abac", value: "false" },
            { key: "deletion_protection", value: prod ? "true" : "false" },
            { key: "resource_labels", value: "local.labels" },
          ], [
            block("ip_allocation_policy", [], []),
            block("private_cluster_config", [], [
              { key: "enable_private_nodes", value: "true" },
              { key: "enable_private_endpoint", value: "false" },
              { key: "master_ipv4_cidr_block", value: `var.${master}` },
            ]),
            block("master_authorized_networks_config", [], [
              // Google's own public ranges are not administrators: the control plane admits the one range below.
              { key: "gcp_public_cidrs_access_enabled", value: "false" },
            ], [
              block("cidr_blocks", [], [
                { key: "cidr_block", value: "var.gke_authorized_cidr" },
                { key: "display_name", value: quote("administrators") },
              ]),
            ]),
            block("master_auth", [], [], [
              block("client_certificate_config", [], [{ key: "issue_client_certificate", value: "false" }]),
            ]),
            block("workload_identity_config", [], [{ key: "workload_pool", value: `"\${var.project_id}.svc.id.goog"` }]),
            block("release_channel", [], [{ key: "channel", value: quote("REGULAR") }]),
            block("network_policy", [], [
              { key: "enabled", value: "true" },
              { key: "provider", value: quote("CALICO") },
            ]),
            block("addons_config", [], [], [
              block("network_policy_config", [], [{ key: "disabled", value: "false" }]),
            ]),
            block("binary_authorization", [], [{ key: "evaluation_mode", value: quote("PROJECT_SINGLETON_POLICY_ENFORCE") }]),
          ]),
          block("resource", ["google_container_node_pool", nodes], [
            { key: "name", value: quote("default") },
            { key: "cluster", value: `google_container_cluster.${c.name}.id` },
            { key: "location", value: location },
            { key: "node_count", value: "1" },
          ], [
            block("management", [], [
              { key: "auto_repair", value: "true" },
              { key: "auto_upgrade", value: "true" },
            ]),
            block("node_config", [], [
              { key: "machine_type", value: quote("e2-standard-2") },
              { key: "image_type", value: quote("COS_CONTAINERD") },
              { key: "service_account", value: `google_service_account.${nodes}.email` },
              { key: "oauth_scopes", value: `["https://www.googleapis.com/auth/cloud-platform"]` },
              { key: "metadata", value: mapExpression([{ key: "disable-legacy-endpoints", value: quote("true") }]) },
            ], [
              block("workload_metadata_config", [], [{ key: "mode", value: quote("GKE_METADATA") }]),
              block("shielded_instance_config", [], [
                { key: "enable_secure_boot", value: "true" },
                { key: "enable_integrity_monitoring", value: "true" },
              ]),
            ]),
          ]),
          serviceAccount(nodes, `${c.slug}-nodes`, `Runs the ${c.slug} cluster's nodes`),
          projectRole(`${nodes}_log_writer`, "roles/logging.logWriter", `google_service_account.${nodes}`),
          projectRole(`${nodes}_metric_writer`, "roles/monitoring.metricWriter", `google_service_account.${nodes}`),
          projectRole(`${nodes}_monitoring_viewer`, "roles/monitoring.viewer", `google_service_account.${nodes}`),
          projectRole(`${nodes}_artifact_reader`, "roles/artifactregistry.reader", `google_service_account.${nodes}`),
        ],
        variables: [
          NAME_PREFIX,
          ...variables,
          {
            name: "gke_authorized_cidr",
            type: "string",
            description: "CIDR block allowed to reach the cluster's control plane: your office or VPN range.",
            validation: {
              condition:
                'can(cidrhost(var.gke_authorized_cidr, 0)) && try(tonumber(split("/", var.gke_authorized_cidr)[1]) >= 24, false) && !startswith(var.gke_authorized_cidr, "0.")',
              message: "Give a CIDR block of a /24 or narrower that is not 0.0.0.0/x: the control plane is reachable from nowhere else.",
            },
          },
          {
            name: master,
            type: "string",
            description: `The /28 of private address space the ${c.slug} control plane takes. It must not overlap the network or another cluster's range.`,
            default: quote(`172.16.${Math.floor(c.gcp.position / 16)}.${(c.gcp.position % 16) * 16}/28`),
            validation: {
              condition: `can(cidrhost(var.${master}, 0)) && endswith(var.${master}, "/28") && can(regex("^(10|172\\\\.(1[6-9]|2[0-9]|3[01])|192\\\\.168)\\\\.", var.${master}))`,
              message: "Give a /28 inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16.",
            },
          },
        ],
        outputs: [{ name: `${c.name}_endpoint`, value: `google_container_cluster.${c.name}.endpoint` }],
      };
    },
  },

  /** A Cloud Run service on its own service account, closed to the world until a grant or a load balancer opens it. */
  containers: {
    emit: (c: GcpContext) => {
      c.gcp.api("run.googleapis.com");
      const size = RUN_SIZE[c.attr("Container size")] ?? (RUN_SIZE["Medium (1 vCPU)"] as { cpu: string; memory: string });
      return {
        blocks: [
          block("resource", ["google_cloud_run_v2_service", c.name], [
            { key: "name", value: cloudName("svc", c.slug) },
            { key: "location", value: "var.region" },
            { key: "ingress", value: quote("INGRESS_TRAFFIC_ALL") },
            { key: "deletion_protection", value: "false" },
          ], [
            block("template", [], [
              { key: "service_account", value: `google_service_account.${c.name}.email` },
              { key: "execution_environment", value: quote("EXECUTION_ENVIRONMENT_GEN2") },
            ], [
              block("scaling", [], [
                { key: "min_instance_count", value: "1" },
                { key: "max_instance_count", value: "10" },
              ]),
              block("containers", [], [{ key: "image", value: quote("us-docker.pkg.dev/cloudrun/container/hello") }], [
                block("ports", [], [{ key: "container_port", value: "8080" }]),
                block("resources", [], [
                  {
                    key: "limits",
                    value: mapExpression([
                      { key: "cpu", value: quote(size.cpu) },
                      { key: "memory", value: quote(size.memory) },
                    ]),
                  },
                ]),
              ]),
              ...(c.net
                ? [
                    block("vpc_access", [], [{ key: "egress", value: quote("PRIVATE_RANGES_ONLY") }], [
                      block("network_interfaces", [], [
                        { key: "network", value: c.net.vpcId },
                        { key: "subnetwork", value: c.net.privateSubnets },
                      ]),
                    ]),
                  ]
                : []),
            ]),
          ]),
          serviceAccount(c.name, c.slug, `Runs the ${c.slug} service`),
          projectRole(`${c.name}_log_writer`, "roles/logging.logWriter", `google_service_account.${c.name}`),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_url`, value: `google_cloud_run_v2_service.${c.name}.uri` }],
      };
    },
  },

  /**
   * A second-generation Cloud Function, packaged from a directory written beside the plan.
   * Its source goes to a private bucket of its own, and it runs as its own service account.
   */
  functions: {
    emit: (c: GcpContext) => {
      c.gcp.api("cloudfunctions.googleapis.com", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "storage.googleapis.com");
      const runtime = FUNCTION_RUNTIME[c.attr("Runtime")] ?? (FUNCTION_RUNTIME["Node.js 22"] as FunctionRuntime);
      const source = `${c.name}_source`;
      const sourceBucket = bucketWithLogs({ ...c, name: source }, { prefix: "src", purpose: "function-source" });
      return {
        blocks: [
          block("resource", ["google_cloudfunctions2_function", c.name], [
            { key: "name", value: cloudName("fn", c.slug) },
            { key: "location", value: "var.region" },
          ], [
            block("build_config", [], [
              { key: "runtime", value: quote(runtime.runtime) },
              { key: "entry_point", value: quote(runtime.entry) },
            ], [
              block("source", [], [], [
                block("storage_source", [], [
                  { key: "bucket", value: `google_storage_bucket.${source}.name` },
                  { key: "object", value: `google_storage_bucket_object.${source}.name` },
                ]),
              ]),
            ]),
            block("service_config", [], [
              { key: "available_memory", value: quote("256M") },
              { key: "timeout_seconds", value: "60" },
              { key: "max_instance_count", value: "10" },
              { key: "ingress_settings", value: quote("ALLOW_INTERNAL_AND_GCLB") },
              { key: "service_account_email", value: `google_service_account.${c.name}.email` },
            ]),
          ]),
          serviceAccount(c.name, c.slug, `Runs the ${c.slug} function`),
          projectRole(`${c.name}_log_writer`, "roles/logging.logWriter", `google_service_account.${c.name}`),
          block("data", ["archive_file", c.name], [
            { key: "type", value: quote("zip") },
            { key: "source_dir", value: quoteTemplate`\${path.module}/src/${c.slug}` },
            { key: "output_path", value: quoteTemplate`\${path.module}/.terraform/${c.slug}.zip` },
          ]),
          ...sourceBucket.blocks,
          block("resource", ["google_storage_bucket_object", source], [
            { key: "name", value: `"\${data.archive_file.${c.name}.output_md5}.zip"` },
            { key: "bucket", value: `google_storage_bucket.${source}.name` },
            { key: "source", value: `data.archive_file.${c.name}.output_path` },
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_url`, value: `google_cloudfunctions2_function.${c.name}.service_config[0].uri` }],
        files: [
          { name: `src/${c.slug}/${runtime.file}`, content: runtime.stub },
          ...(runtime.extra ?? []).map((f) => ({ name: `src/${c.slug}/${f.file}`, content: f.stub })),
        ],
      };
    },
  },

  /** A bucket, hardened and logged; wired to the plan's key store it is encrypted under that store's key. */
  objectStorage: {
    emit: (c: GcpContext) => {
      c.gcp.api("storage.googleapis.com");
      const { bucket, blocks } = bucketWithLogs(c, { prefix: "data" });
      return {
        blocks,
        referent: blocks.indexOf(bucket),
        consumer: blocks.indexOf(bucket),
        variables: [NAME_PREFIX],
      };
    },
  },

  /** A Pub/Sub topic with a subscription, and a dead-letter topic for what the subscription gives up on. */
  queue: {
    emit: (c: GcpContext) => {
      c.gcp.api("pubsub.googleapis.com");
      const exactlyOnce = c.attr("Delivery") === "Exactly once (FIFO)";
      const dead = `${c.name}_dead_letter`;
      return {
        blocks: [
          block("resource", ["google_pubsub_topic", c.name], [
            { key: "name", value: cloudName("topic", c.slug) },
            { key: "message_retention_duration", value: quote("604800s") },
          ]),
          block("resource", ["google_pubsub_topic", dead], [
            { key: "name", value: cloudName("dlq", c.slug) },
            { key: "message_retention_duration", value: quote("604800s") },
          ]),
          block("resource", ["google_pubsub_subscription", c.name], [
            { key: "name", value: cloudName("sub", c.slug) },
            { key: "topic", value: `google_pubsub_topic.${c.name}.id` },
            { key: "ack_deadline_seconds", value: "30" },
            { key: "message_retention_duration", value: quote("604800s") },
            { key: "enable_message_ordering", value: String(exactlyOnce) },
            { key: "enable_exactly_once_delivery", value: String(exactlyOnce) },
          ], [
            block("dead_letter_policy", [], [
              { key: "dead_letter_topic", value: `google_pubsub_topic.${dead}.id` },
              { key: "max_delivery_attempts", value: "5" },
            ]),
            block("expiration_policy", [], [{ key: "ttl", value: quote("") }]),
          ]),
        ],
        variables: [NAME_PREFIX],
      };
    },
  },

  /** Secret Manager's secret under a Cloud KMS key of its own, which rotates every 90 days. No value is ever written. */
  keyVault: {
    emit: (c: GcpContext) => {
      c.gcp.api("secretmanager.googleapis.com", "cloudkms.googleapis.com");
      return {
        blocks: [
          block("resource", ["google_secret_manager_secret", c.name], [
            { key: "secret_id", value: cloudName("secret", c.slug) },
          ], [
            block("replication", [], [], [
              block("user_managed", [], [], [
                block("replicas", [], [
                  { key: "location", value: "var.region" },
                ], [
                  block("customer_managed_encryption", [], [
                    { key: "kms_key_name", value: `google_kms_crypto_key.${c.name}.id` },
                  ]),
                ]),
              ]),
            ]),
          ]),
          block("resource", ["google_kms_key_ring", c.name], [
            { key: "name", value: cloudName("keyring", c.slug) },
            { key: "location", value: "var.region" },
          ]),
          block("resource", ["google_kms_crypto_key", c.name], [
            { key: "name", value: cloudName("key", c.slug) },
            { key: "key_ring", value: `google_kms_key_ring.${c.name}.id` },
            { key: "purpose", value: quote("ENCRYPT_DECRYPT") },
            { key: "rotation_period", value: quote("7776000s") },
          ], [
            block("version_template", [], [
              { key: "algorithm", value: quote("GOOGLE_SYMMETRIC_ENCRYPTION") },
              { key: "protection_level", value: quote("SOFTWARE") },
            ]),
          ]),
          // Secret Manager reads the key as its own service identity.
          block("resource", ["google_project_service_identity", `${c.name}_secretmanager`], [
            { key: "provider", value: GCP_BETA_REF },
            { key: "service", value: quote("secretmanager.googleapis.com") },
          ]),
          block("resource", ["google_kms_crypto_key_iam_member", c.name], [
            { key: "crypto_key_id", value: `google_kms_crypto_key.${c.name}.id` },
            { key: "role", value: quote("roles/cloudkms.cryptoKeyEncrypterDecrypter") },
            { key: "member", value: `"serviceAccount:\${google_project_service_identity.${c.name}_secretmanager.email}"` },
          ]),
        ],
        variables: [NAME_PREFIX],
      };
    },
  },

  /** A service account: the identity workloads run as. */
  identity: {
    emit: (c: GcpContext) => {
      c.gcp.api("iam.googleapis.com");
      return { blocks: [serviceAccount(c.name, c.slug, `Identity for ${c.slug}`)], variables: [NAME_PREFIX] };
    },
  },

  /** The project's default log bucket kept for the chosen retention, and an alert that emails on error logs. */
  monitoring: {
    emit: (c: GcpContext) => {
      c.gcp.api("monitoring.googleapis.com", "logging.googleapis.com");
      const days = { "30 days": "30", "90 days": "90", "1 year": "365" }[c.attr("Log retention")] ?? "30";
      return {
        blocks: [
          block("resource", ["google_monitoring_notification_channel", c.name], [
            { key: "display_name", value: cloudName("alerts", c.slug) },
            { key: "type", value: quote("email") },
            { key: "labels", value: mapExpression([{ key: "email_address", value: "var.alert_email" }]) },
          ]),
          block("resource", ["google_monitoring_alert_policy", c.name], [
            { key: "display_name", value: cloudName("errors", c.slug) },
            { key: "combiner", value: quote("OR") },
            { key: "notification_channels", value: `[google_monitoring_notification_channel.${c.name}.id]` },
          ], [
            block("conditions", [], [{ key: "display_name", value: quote("Error logs") }], [
              block("condition_matched_log", [], [{ key: "filter", value: quote("severity>=ERROR") }]),
            ]),
            block("alert_strategy", [], [], [
              block("notification_rate_limit", [], [{ key: "period", value: quote("300s") }]),
            ]),
          ]),
          block("resource", ["google_logging_project_bucket_config", c.name], [
            { key: "project", value: "var.project_id" },
            { key: "location", value: quote("global") },
            { key: "bucket_id", value: quote("_Default") },
            { key: "retention_days", value: days },
          ]),
        ],
        referent: 2,
        variables: [
          NAME_PREFIX,
          { name: "alert_email", type: "string", description: "Address the plan's alert policy emails when error logs appear." },
        ],
      };
    },
  },

  postgres: {
    emit: (c: GcpContext) =>
      sqlInstance(c, { ...POSTGRES, version: PG_DATABASE_VERSION[c.attr("PostgreSQL version")] ?? "POSTGRES_16" }, "pg"),
  },
  mysql: {
    emit: (c: GcpContext) =>
      sqlInstance(c, { ...MYSQL, version: MYSQL_DATABASE_VERSION[c.attr("MySQL version")] ?? "MYSQL_8_4" }, "mysql"),
  },

  /** Memorystore for Redis on the plan's network, with AUTH and TLS on. */
  redis: {
    emit: (c: GcpContext) => {
      c.gcp.api("redis.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com");
      const { vpc, variables } = netOrVars(c.net);
      const connection = c.gcp.privateServices(vpc);
      const sku = REDIS_TIER[c.attr("Cache SKU")] ?? (REDIS_TIER["Standard (C1)"] as { tier: string; size: string });
      return {
        blocks: [
          block("resource", ["google_redis_instance", c.name], [
            { key: "name", value: cloudName("redis", c.slug) },
            { key: "region", value: "var.region" },
            { key: "tier", value: quote(sku.tier) },
            { key: "memory_size_gb", value: sku.size },
            { key: "redis_version", value: quote("REDIS_7_2") },
            { key: "authorized_network", value: vpc },
            { key: "connect_mode", value: quote("PRIVATE_SERVICE_ACCESS") },
            { key: "auth_enabled", value: "true" },
            { key: "transit_encryption_mode", value: quote("SERVER_AUTHENTICATION") },
            { key: "depends_on", value: `[${connection}]` },
          ]),
        ],
        variables: [NAME_PREFIX, ...variables],
        outputs: [{ name: `${c.name}_host`, value: `google_redis_instance.${c.name}.host` }],
      };
    },
  },

  /** A Firestore database in native mode with point-in-time recovery. */
  nosql: {
    emit: (c: GcpContext) => {
      c.gcp.api("firestore.googleapis.com");
      return {
        blocks: [
          block("resource", ["google_firestore_database", c.name], [
            { key: "name", value: cloudName("fs", c.slug) },
            { key: "location_id", value: "var.region" },
            { key: "type", value: quote("FIRESTORE_NATIVE") },
            { key: "point_in_time_recovery_enablement", value: quote("POINT_IN_TIME_RECOVERY_ENABLED") },
            { key: "delete_protection_state", value: quote(production(c) ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED") },
            { key: "deletion_policy", value: quote(production(c) ? "ABANDON" : "DELETE") },
          ]),
        ],
        variables: [NAME_PREFIX],
      };
    },
  },

  /** A BigQuery dataset: encrypted by Google, no public grant, deletable only when empty in production. */
  dataWarehouse: {
    emit: (c: GcpContext) => {
      c.gcp.api("bigquery.googleapis.com");
      return {
        blocks: [
          block("resource", ["google_bigquery_dataset", c.name], [
            { key: "dataset_id", value: `replace(${cloudName("dw", c.slug)}, "-", "_")` },
            { key: "location", value: "var.region" },
            { key: "delete_contents_on_destroy", value: production(c) ? "false" : "true" },
          ]),
        ],
        variables: [NAME_PREFIX],
      };
    },
  },

  /** A project the plan creates, with data-access audit logs on and no default network. */
  project: {
    emit: (c: GcpContext) => {
      c.gcp.api("cloudresourcemanager.googleapis.com", "serviceusage.googleapis.com");
      return {
        blocks: [
          block("resource", ["google_project", c.name], [
            { key: "name", value: "var.project_id" },
            { key: "project_id", value: "var.project_id" },
            { key: "org_id", value: "var.org_id" },
            { key: "billing_account", value: "var.billing_account" },
            { key: "auto_create_network", value: "false" },
          ]),
          block("resource", ["google_project_iam_audit_config", c.name], [
            { key: "project", value: `google_project.${c.name}.project_id` },
            { key: "service", value: quote("allServices") },
          ], [
            block("audit_log_config", [], [{ key: "log_type", value: quote("ADMIN_READ") }]),
            block("audit_log_config", [], [{ key: "log_type", value: quote("DATA_READ") }]),
            block("audit_log_config", [], [{ key: "log_type", value: quote("DATA_WRITE") }]),
          ]),
        ],
        variables: [
          {
            name: "billing_account",
            type: "string",
            description: "Billing account the project is billed to, such as 012345-6789AB-CDEF01.",
          },
          {
            name: "org_id",
            type: "string",
            description: "Organisation the project is created in; leave null for a project with no organisation.",
            default: "null",
          },
        ],
        outputs: [{ name: `${c.name}_number`, value: `google_project.${c.name}.number` }],
      };
    },
  },
} as const;

/** Resources that make a private service connection: one range, one peering, per network. */
export function privateServicesBlocks(networkId: string): HclBlock[] {
  return [
    block("resource", ["google_compute_global_address", "private_services"], [
      { key: "name", value: cloudName("private-services", "range") },
      { key: "purpose", value: quote("VPC_PEERING") },
      { key: "address_type", value: quote("INTERNAL") },
      { key: "prefix_length", value: "20" },
      { key: "network", value: networkId },
    ]),
    block("resource", ["google_service_networking_connection", "private_services"], [
      { key: "network", value: networkId },
      { key: "service", value: quote("servicenetworking.googleapis.com") },
      { key: "reserved_peering_ranges", value: "[google_compute_global_address.private_services.name]" },
      { key: "deletion_policy", value: quote("ABANDON") },
    ]),
  ];
}
