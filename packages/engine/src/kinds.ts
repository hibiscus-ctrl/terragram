// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import {
  addMapEntry,
  block,
  type HclBlock,
  mapEntries,
  mapExpression,
  quote,
  quoteTemplate,
  stringValue,
} from "./hcl.ts";
import type { Cloud, GeneratedCloud, ModelNode, NodeCategory, ReviewFlag } from "./model.ts";
import { MODULE_VERSIONS, type ModuleKey } from "./module-versions.ts";
import { PROVIDER_VERSIONS } from "./provider-versions.ts";
import { isAzureScaffold, sameAttributes, squash } from "./scaffold.ts";
import {
  appEngineClassFrom,
  finalizeFrontend,
  functionRuntimeFrom,
  GCP,
  type GcpPlan,
  isEdgeBlock,
  isGcpDeadLetterTopic,
  isGcpQueueSubscription,
  isGcpScaffold,
  redisSkuFrom,
  runSizeFrom,
} from "./gcp-kinds.ts";

/**
 * The kind registry — the single place a resource kind is defined.
 *
 * Before this existed, adding one kind meant editing four hand-kept tables that
 * nothing forced to agree: the engine's keyword list, two emit switches, and the
 * inspector's field map. A kind now owns all of it in one entry: its category and
 * label, where it sits on the ingress spine, the words that detect it, the review
 * flag it raises, the attributes a reviewer can set, and — per cloud — the HCL it
 * emits, the resource types that reverse-map back to it, and how other resources
 * consume it.
 *
 * The managed model's forced-tool vocabulary is derived from this list too, so
 * widening the registry widens managed inference by construction.
 */

/* ------------------------------------------------------------------- types -- */

export type KindField = {
  /** Stored as the key in `node.attributes` and shown as the field label. */
  key: string;
  /** Fixed choices render a <select>; omitted renders free text. */
  options?: readonly string[];
  /** Used when the reviewer hasn't chosen — always mirrors the emit default. */
  fallback: string;
  /** For free text: why a value cannot be used, or null when it can. Such a value is
   *  written into the plan, so it is checked before anything is emitted. */
  validate?: (value: string, cloud?: Cloud) => string | null;
  /** For free text: the form of an accepted value that is emitted, when it differs from
   *  how the reviewer wrote it (a DNS name's trailing dot). Applied before `attr` returns. */
  normalize?: (value: string) => string;
  /** Phrases in a plain-English brief that choose an option ("powered by Python"),
   *  so the deterministic engine reads the same facts a reviewer would set by hand.
   *  First match wins; listed most specific first. */
  prompt?: ReadonlyArray<{ option: string; pattern: RegExp }>;
};

/**
 * Where a kind sits in the request path. `ingress` kinds chain in `order`;
 * `serving` kinds are the application tier every leaf hangs off.
 */
type KindRole = "conceptual" | "ingress" | "serving" | "leaf" | "external";

/** A rendered reference to an emitted block: `azurerm_service_plan.web`, or
 *  `module.functions` when the kind is emitted from a registry module. */
export type EmitRef = { type: string; name: string };

/**
 * What a network offers the resources placed in it. When the model has a network
 * kind these are that module's outputs; when it has none, consumers fall back to
 * variables Terraform asks for (`netOrVars`) — never an empty default, which would
 * carry a plan with zero subnets all the way to the provider's error.
 */
export type NetworkRefs = { vpcId: string; publicSubnets: string; privateSubnets: string };

/** `module "<name>"` with a pinned registry source, the inputs, and nothing else —
 *  the shape Terragram prefers wherever a maintained module exists for the kind.
 *  `subdir` selects a submodule of the same pinned release (`//modules/service`). */
function moduleBlock(
  key: ModuleKey,
  name: string,
  inputs: Array<{ key: string; value: string | undefined } | null | undefined>,
  subdir?: string,
): HclBlock {
  const pin = MODULE_VERSIONS[key];
  return block("module", [name], [
    { key: "source", value: quote(subdir ? `${pin.source}//${subdir}` : pin.source) },
    { key: "version", value: quote(pin.version) },
    ...inputs,
  ]);
}

export function refAddress(ref: EmitRef, attribute?: string): string {
  return attribute ? `${ref.type}.${ref.name}.${attribute}` : `${ref.type}.${ref.name}`;
}

export type EmitContext = {
  node: ModelNode;
  /** Unique Terraform block name for this node (`postgres`, `postgres_2`). */
  name: string;
  /** Unique kebab fragment for cloud resource names (`postgres`, `postgres-2`). */
  slug: string;
  /** A reviewer-confirmed attribute, else the field's fallback. */
  attr: (key: string) => string;
  /** The model's network on this cloud, or null when it has none. */
  net: NetworkRefs | null;
  /** The Azure plan's private network, which every Azure plan has; null elsewhere. */
  private: PrivateNetwork | null;
  /** What a Google Cloud kind asks of the plan around it (APIs, private service access); null elsewhere. */
  gcp: GcpPlan | null;
};

/**
 * What an Azure plan's virtual network offers the kind being emitted. Asking for
 * a subnet or a zone is what creates it: the plan's network carries exactly the
 * subnets and private DNS zones its kinds asked for (see `terraform.ts`).
 */
export type PrivateNetwork = {
  /** The id of a subnet of the plan's network, delegated to `delegation` when a
   *  service has to own the subnet it runs in, with default outbound access when
   *  what runs there reaches the internet from it. One key, one subnet. */
  subnet: (key: string, delegation?: string, outbound?: boolean) => string;
  /** The id of a private DNS zone linked to the plan's network. */
  dnsZone: (zone: string) => string;
};

/** The subnet every private endpoint in a plan is placed in. */
const ENDPOINTS_SUBNET = "private-endpoints";

/**
 * A private endpoint for a resource, in the plan's endpoint subnet, registered in
 * the private DNS zone its service resolves through — so the resource's public
 * name resolves to the endpoint from inside the network and to nothing reachable
 * from outside it.
 */
function privateEndpoint(
  c: EmitContext,
  zone: string,
  subresource?: string,
): { key: string; value: string } | null {
  if (!c.private) return null;
  return {
    key: "private_endpoints",
    value: mapExpression([
      {
        key: "primary",
        value: mapExpression([
          { key: "subnet_resource_id", value: c.private.subnet(ENDPOINTS_SUBNET) },
          { key: "private_dns_zone_resource_ids", value: `[${c.private.dnsZone(zone)}]` },
          // Some modules leave the endpoint's target sub-resource to the caller.
          subresource ? { key: "subresource_name", value: quote(subresource) } : null,
        ].filter((e) => e !== null)),
      },
    ]),
  };
}

export type VariableSpec = {
  name: string;
  type: string;
  description?: string;
  default?: string;
  sensitive?: boolean;
  /** A rule the value has to satisfy, checked by Terraform before anything is planned. */
  validation?: { condition: string; message: string };
};

/**
 * Where dependency settings land on a consumer. Kinds without one fall back to
 * `depends_on`, which is honest: we only claim a wire where the provider has a
 * real place to put it.
 */
export type SettingsTarget = {
  /** Index into the emitted blocks. Defaults to the consumer block. */
  blockIndex?: number;
  /** A child block to create or reuse (Lambda's `environment`). */
  nestedBlock?: string;
  /** The map attribute that holds the settings. */
  attribute: string;
  /** Where the provider has no map for them (Cloud Run's repeated `env` blocks), how an entry is written instead. */
  append?: (host: HclBlock, entry: { key: string; value: string }) => void;
};

type CloudEmit = {
  blocks: HclBlock[];
  /** Block other resources reference when they depend on this node. Default 0. */
  referent?: number;
  /** Block that receives wiring when this node depends on something. Default 0. */
  consumer?: number;
  outputs?: Array<{ name: string; value: string }>;
  variables?: VariableSpec[];
  /** Files written beside the plan that the plan itself refers to — a function's
   *  handler source, which the Lambda module packages at plan time. Never HCL. */
  files?: Array<{ name: string; content: string }>;
};

export type CloudSpec = {
  /** Primary Terraform resource type — what the reverse map keys on. */
  type: string;
  /** Further resource types that also reverse-map to this kind. */
  matches?: readonly string[];
  /** Disambiguates a type two kinds share (`aws_db_instance` is postgres or mysql). */
  matchBlock?: (block: HclBlock) => boolean;
  emit: (ctx: EmitContext) => CloudEmit;
  /** Inspector attributes read back out of a parsed primary block — the exact
   *  inverse of `emit`, kept beside it so the two cannot drift. */
  read?: (block: HclBlock) => Record<string, string>;
  /** Where dependency settings go when this kind consumes another. */
  settings?: SettingsTarget;
  /** How another resource consumes this one: an env key and the expression. */
  connection?: (ref: EmitRef) => { key: string; value: string };
  /** The hostname expression an ingress tier points at. */
  hostname?: (ref: EmitRef) => string;
  /** For a tier that answers on an address rather than a name: the resource a
   *  DNS alias record points at, so the zone publishes an A record that follows
   *  the address instead of a CNAME to it. */
  addressResource?: (ref: EmitRef) => string;
  /** The registry module this kind is emitted from, when a maintained one exists.
   *  Recorded in the receipt's SBOM, and what a module block reads back through. */
  moduleSource?: string;
  /** Further module sources that also reverse-map to this kind — the cluster
   *  beside an ECS service — the way `matches` does for resource types. */
  moduleMatches?: readonly string[];
  /** What this kind offers resources placed in it, by its Terraform name. The one
   *  network kind on a cloud sets `EmitContext.net` for every other kind. */
  network?: (name: string) => NetworkRefs;
  /** Runs once every edge is wired, on the block other resources reference — for
   *  shapes the provider only accepts complete (a CloudFront distribution needs an
   *  origin AND a default behaviour naming it). Returns any variables it introduced. */
  finalize?: (host: HclBlock, ctx: EmitContext) => VariableSpec[];
  /** Serve the hostname a DNS zone points at this ingress tier, over HTTPS, on a
   *  certificate validated through that zone. Without it the zone's record names a
   *  host the tier does not answer for. Returns any blocks it adds. */
  customDomain?: (host: HclBlock, domain: CustomDomain, blocks: HclBlock[]) => HclBlock[];
};

/**
 * What a kind needs on a cloud Terragram reads but does not generate: the resource
 * types that reverse-map to it, how to tell it from a kind that shares one, and what an
 * inspector value reads back as. No `emit`, so such a cloud has no Terraform to write.
 */
export type ReadSpec = Pick<CloudSpec, "type" | "matches" | "matchBlock" | "read" | "moduleSource" | "moduleMatches">;

/** A Google Cloud kind's spec: what it reads back from, and, when Terragram builds it, how. */
type GcpSpec = ReadSpec & Partial<Omit<CloudSpec, keyof ReadSpec>>;

/** A hostname the plan's own DNS zone publishes, and where that zone's records go. */
export type CustomDomain = {
  /** Terraform name for the blocks the domain adds. */
  name: string;
  /** The record's name inside the zone: `www`, the one name the zone wires. */
  record: string;
  /** `<record>.<zone>`. */
  fqdn: string;
  zoneName: string;
  /** The zone's id, as the provider's records and certificates name it. */
  zoneId: string;
  /** The zone's own block, for a cloud whose records are inputs to the zone module. */
  zone: HclBlock;
};

export type KindDefinition = {
  kind: string;
  category: NodeCategory;
  label: string;
  role: KindRole;
  /** Ingress ordering, lower is closer to the internet. Ingress kinds only. */
  order?: number;
  flag?: ReviewFlag;
  /** Whether the derived spine puts an edge tier in front of this serving kind by
   *  default. Functions expose their own URL, so a CDN is a choice, not a given. */
  fronted?: boolean;
  keywords: readonly string[];
  fields: readonly KindField[];
  azure: CloudSpec | null;
  aws: CloudSpec | null;
  /** Google Cloud. With an `emit` the kind is built; without one it is read, drawn and explained only. */
  gcp?: GcpSpec | null;
};

/* ----------------------------------------------------------- option tables -- */

/** Map an inspector option to the provider value, with the inverse for parsing. */
function options<T extends Record<string, string>>(table: T) {
  const reverse = new Map(Object.entries(table).map(([label, value]) => [value, label]));
  return {
    labels: Object.keys(table) as readonly string[],
    to: (label: string, fallback: string): string => table[label] ?? table[fallback] ?? fallback,
    from: (value: string | undefined): string | undefined =>
      value === undefined ? undefined : reverse.get(value),
  };
}

const APP_TIER_AZURE = options({
  "Dev / Test": "B1",
  "Standard (P1v3)": "P1v3",
  "Production (P3v3)": "P3v3",
});
const APP_TIER_AWS = options({
  "Dev / Test": "t3.small",
  "Standard (P1v3)": "t3.medium",
  "Production (P3v3)": "t3.xlarge",
});
const APP_TIER_FIELD: KindField = {
  key: "Compute tier",
  options: APP_TIER_AZURE.labels,
  fallback: "Standard (P1v3)",
};

/**
 * Production posture, as a choice the reviewer makes rather than one we guess.
 *
 * A generated plan has two incompatible jobs: it has to be destroyable while it is
 * a trial, and it has to be defensible the day it stops being one. The difference
 * between those is not hardening — TLS floors and encryption are on either way —
 * it is the settings that cost money or block a `destroy`: zone-redundant standby,
 * long backup retention, geo-redundant backup, deletion protection, a final
 * snapshot. Those follow this field and nothing else.
 *
 * It sits on the stateful kinds only, because those are the ones where the answer
 * changes the plan. The brief chooses it when it says so ("for production", "a
 * sandbox"); otherwise the reviewer does, at the gate.
 */
const ENVIRONMENT = options({ "Dev / Test": "dev", Production: "production" });
const ENVIRONMENT_FIELD: KindField = {
  key: "Environment",
  options: ENVIRONMENT.labels,
  fallback: "Dev / Test",
  prompt: [
    { option: "Dev / Test", pattern: /\b(dev|development|test|sandbox|staging|demo|proof of concept|poc|prototype|trial)\b/i },
    { option: "Production", pattern: /\b(production|prod|live|go[- ]?live)\b/i },
  ],
};

/** Whether this node's reviewer-chosen environment is the production one. */
function isProduction(c: EmitContext): boolean {
  return ENVIRONMENT.to(c.attr("Environment"), "Dev / Test") === "production";
}

/**
 * The plan's posture, for the things that are per-plan rather than per-resource —
 * the Environment tag, today. One plan is one environment: a production database
 * beside a dev cache is a mistake, not a configuration, so any component saying
 * production makes the plan production.
 */
export function modelIsProduction(nodes: readonly ModelNode[]): boolean {
  return nodes.some((n) => n.attributes?.[ENVIRONMENT_FIELD.key] === "Production");
}

// Only majors the community still supports (14 reached end of life on 12 November 2026).
const PG_VERSION = options({
  "PostgreSQL 18": "18",
  "PostgreSQL 17": "17",
  "PostgreSQL 16": "16",
  "PostgreSQL 15": "15",
});
const PG_FIELD: KindField = {
  key: "PostgreSQL version",
  options: PG_VERSION.labels,
  fallback: "PostgreSQL 16",
  prompt: [
    { option: "PostgreSQL 15", pattern: /\bpostgres(?:ql)?\s*15\b/i },
    { option: "PostgreSQL 16", pattern: /\bpostgres(?:ql)?\s*16\b/i },
    { option: "PostgreSQL 17", pattern: /\bpostgres(?:ql)?\s*17\b/i },
    { option: "PostgreSQL 18", pattern: /\bpostgres(?:ql)?\s*18\b/i },
  ],
};
// The two providers spell the same major differently: RDS takes a major ("8.0"),
// Azure Flexible Server wants the exact minor it supports ("8.0.21").
// 5.7 and 8.0 are past end of life (October 2023, April 2026); 8.4 is the long-term release.
const MYSQL_VERSION_AWS = options({ "MySQL 8.4": "8.4" });
const MYSQL_VERSION_AZURE = options({ "MySQL 8.4": "8.4" });
const MYSQL_FIELD: KindField = {
  key: "MySQL version",
  options: MYSQL_VERSION_AWS.labels,
  fallback: "MySQL 8.4",
  prompt: [
    { option: "MySQL 8.4", pattern: /\bmysql\s*8\.4\b/i },
  ],
};

const REDIS_SKU_AZURE = options({
  "Basic (C0)": "Basic",
  "Standard (C1)": "Standard",
  "Premium (P1)": "Premium",
});
const REDIS_CAPACITY_AZURE: Record<string, { capacity: string; family: string }> = {
  "Basic (C0)": { capacity: "0", family: "C" },
  "Standard (C1)": { capacity: "1", family: "C" },
  "Premium (P1)": { capacity: "1", family: "P" },
};
const REDIS_NODE_AWS = options({
  "Basic (C0)": "cache.t3.micro",
  "Standard (C1)": "cache.t3.small",
  "Premium (P1)": "cache.m6g.large",
});
const REDIS_FIELD: KindField = {
  key: "Cache SKU",
  options: REDIS_SKU_AZURE.labels,
  fallback: "Standard (C1)",
};

const REDUNDANCY = options({ "Local (LRS)": "LRS", "Zone (ZRS)": "ZRS", "Geo (GRS)": "GRS" });

const RUNTIME = options({ "Node.js 22": "22", "Python 3.12": "3.12", "Java 21": "21" });
const RUNTIME_FIELD: KindField = {
  key: "Runtime",
  options: RUNTIME.labels,
  fallback: "Node.js 22",
  prompt: [
    { option: "Python 3.12", pattern: /\bpython\b/i },
    { option: "Java 21", pattern: /\b(?:java|kotlin)\b/i },
    { option: "Node.js 22", pattern: /\b(?:node(?:\.js)?|typescript|javascript)\b/i },
  ],
};
/**
 * What each runtime is called by Lambda, the handler AWS documents for it, and the
 * source file that handler names. The file is emitted beside the plan: the module
 * packages `source_path` during `terraform plan`, so a directory that does not exist
 * — which is what a plan with no source is — fails before AWS is ever contacted.
 * The stub answers 200 so the deployment can be proven end to end, then replaced.
 */
type LambdaRuntime = { runtime: string; handler: string; file: string; stub: string };
const LAMBDA_RUNTIME: Record<string, LambdaRuntime> = {
  "Node.js 22": {
    runtime: "nodejs22.x",
    handler: "index.handler",
    file: "index.mjs",
    stub: [
      "// Placeholder handler — replace with your function's code.",
      "// `terraform plan` packages this directory (see `source_path` in main.tf), so the",
      "// directory must exist and hold the file the handler names.",
      "export const handler = async () => ({",
      "  statusCode: 200,",
      "  headers: { \"content-type\": \"application/json\" },",
      "  body: JSON.stringify({ ok: true, message: \"Replace this placeholder with your function.\" }),",
      "});",
      "",
    ].join("\n"),
  },
  "Python 3.12": {
    runtime: "python3.12",
    handler: "lambda_function.lambda_handler",
    file: "lambda_function.py",
    stub: [
      "\"\"\"Placeholder handler — replace with your function's code.",
      "",
      "`terraform plan` packages this directory (see `source_path` in main.tf), so the",
      "directory must exist and hold the file the handler names.",
      "\"\"\"",
      "",
      "import json",
      "",
      "",
      "def lambda_handler(event, context):",
      "    return {",
      "        \"statusCode\": 200,",
      "        \"headers\": {\"content-type\": \"application/json\"},",
      "        \"body\": json.dumps({\"ok\": True, \"message\": \"Replace this placeholder with your function.\"}),",
      "    }",
      "",
    ].join("\n"),
  },
  "Java 21": {
    runtime: "java21",
    handler: "example.Handler::handleRequest",
    file: "example/Handler.java",
    stub: [
      "package example;",
      "",
      "// Placeholder handler. A Java function deploys as a BUILT jar: compile this,",
      "// then point `source_path` in main.tf at the build output (or set `create_package = false`",
      "// and `local_existing_package`). As source it lets `terraform plan` run; it will not execute.",
      "import com.amazonaws.services.lambda.runtime.Context;",
      "import com.amazonaws.services.lambda.runtime.RequestHandler;",
      "",
      "public class Handler implements RequestHandler<Object, String> {",
      "  @Override",
      "  public String handleRequest(Object input, Context context) {",
      "    return \"ok\";",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
};
/** Where a runtime sits in a Linux Function App's `site_config.application_stack`:
 *  the language family, then the version key that family uses. */
const AZ_FUNCTION_STACK: Record<string, { family: string; key: string; value: string }> = {
  "Node.js 22": { family: "node", key: "node_version", value: "22" },
  "Python 3.12": { family: "python", key: "python_version", value: "3.12" },
  "Java 21": { family: "java", key: "java_version", value: "21" },
};
function lambdaRuntime(label: string): LambdaRuntime {
  return LAMBDA_RUNTIME[label] ?? (LAMBDA_RUNTIME["Node.js 22"] as LambdaRuntime);
}
function azFunctionStack(label: string): { family: string; key: string; value: string } {
  const fallback = AZ_FUNCTION_STACK["Node.js 22"] as { family: string; key: string; value: string };
  return AZ_FUNCTION_STACK[label] ?? fallback;
}

const DELIVERY = options({ "At least once": "false", "Exactly once (FIFO)": "true" });
const DELIVERY_FIELD: KindField = {
  key: "Delivery",
  options: DELIVERY.labels,
  fallback: "At least once",
};

/**
 * An IPv4 CIDR block such as `10.0.0.0/16`: four octets and a prefix length. RFC 1918 space, whole, and the shared
 * address space 100.64.0.0/10 (RFC 6598, carrier-grade NAT, which AWS and Azure networks use) are accepted on every
 * cloud. On AWS and Azure any other block a network can be built from is accepted too, but never one wider than a /8
 * (0.0.0.0/0 is the internet); on Google Cloud, where a firewall rule is written from the network's own range, nothing else is.
 */
function cidrProblem(value: string, cloud?: Cloud): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  const [, a, b, c, d, prefix] = match ?? [];
  const valid = match !== null && [a, b, c, d].every((octet) => Number(octet) <= 255) && Number(prefix) <= 32;
  if (!valid) return `${JSON.stringify(value)} is not an IPv4 CIDR block such as 10.0.0.0/16`;
  const first = Number(a);
  const second = Number(b);
  const length = Number(prefix);
  const private1918 =
    (first === 10 && length >= 8) ||
    (first === 172 && second >= 16 && second <= 31 && length >= 12) ||
    (first === 192 && second === 168 && length >= 16);
  const sharedSpace = first === 100 && second >= 64 && second <= 127 && length >= 10;
  if (private1918 || sharedSpace) return null;
  if (cloud === "aws" || cloud === "azure") {
    return length >= 8 ? null : `${JSON.stringify(value)} is wider than a /8, which no network is: use a block such as 10.0.0.0/16`;
  }
  return `${JSON.stringify(value)} is not a private address range: use a block inside 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 100.64.0.0/10, such as 10.0.0.0/16`;
}

/** A DNS name without the root label's dot: `example.com.` is `example.com`. */
function withoutTrailingDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

/**
 * A DNS name such as `example.gov.uk`: dot-separated labels of letters, digits and hyphens,
 * with the root dot optional (`example.com.` is accepted and emitted as `example.com`).
 * A single label is refused: the zone is a public one, delegated from a registrar, and
 * neither target hosts a top-level domain. Route 53 documents that it does not, Azure DNS
 * refuses a name that is only a public suffix, and Azure Private DNS needs two labels too.
 */
function hostnameProblem(value: string): string | null {
  const name = withoutTrailingDot(value);
  const labels = name.split(".");
  const wellFormed =
    name.length <= 253 && labels.every((label) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
  if (wellFormed && labels.length >= 2) return null;
  const shape = `is not a DNS name such as example.gov.uk (letters, digits and hyphens between dots)`;
  return wellFormed
    ? `${JSON.stringify(value)} ${shape}: it has one label, and Route 53 and Azure DNS zones need a domain with at least two, since they do not host top-level domains`
    : `${JSON.stringify(value)} ${shape}`;
}

const CIDR_FIELD: KindField = { key: "Address space", fallback: "10.0.0.0/16", validate: cidrProblem };

const CONTAINER_SIZE_AZURE = options({
  "Small (0.5 vCPU)": "0.5",
  "Medium (1 vCPU)": "1.0",
  "Large (2 vCPU)": "2.0",
});
const CONTAINER_SIZE_AWS = options({
  "Small (0.5 vCPU)": "512",
  "Medium (1 vCPU)": "1024",
  "Large (2 vCPU)": "2048",
});
const CONTAINER_SIZE_FIELD: KindField = {
  key: "Container size",
  options: CONTAINER_SIZE_AZURE.labels,
  fallback: "Medium (1 vCPU)",
};

const RETENTION = options({ "30 days": "30", "90 days": "90", "1 year": "365" });
const RETENTION_FIELD: KindField = {
  key: "Log retention",
  options: RETENTION.labels,
  fallback: "30 days",
};

const DNS_ZONE_FIELD: KindField = {
  key: "Zone name",
  fallback: "example.gov.uk",
  validate: hostnameProblem,
  normalize: withoutTrailingDot,
};

/* --------------------------------------------------------------- variables -- */

const NAME_PREFIX: VariableSpec = {
  name: "name_prefix",
  type: "string",
  description: "Short prefix applied to every resource name.",
  default: quote("infra-prod"),
};
/**
 * Ownership and cost allocation are the first two questions asked of any estate,
 * and neither can be answered from a resource name. Every resource in the plan
 * carries the same tag set: a computed base (see `terraform.ts`) that this
 * variable adds to and can override, so a reviewer who has a team name and a cost
 * code has one place to put them.
 */
export const TAGS: VariableSpec = {
  name: "tags",
  type: "map(string)",
  description:
    "Tags added to every resource — Owner and CostCentre are what a reviewer asks for first. Merged over the plan's own tags, so a key set here wins.",
  default: "{}",
};
const TENANT_ID: VariableSpec = {
  name: "tenant_id",
  type: "string",
  description: "Entra tenant that owns Key Vault access policies.",
  default: quote(""),
};

const DB_USERNAME: VariableSpec = {
  name: "db_username",
  type: "string",
  description: "Administrator login for the managed database.",
  default: quote("app"),
};
// No default on purpose: an empty string would carry the plan to `apply` and fail
// there, at the provider. Without one Terraform asks, which is the honest moment.
const DB_PASSWORD: VariableSpec = {
  name: "db_password",
  type: "string",
  description: "Administrator password. Supply it from your secret store at plan time, never in VCS.",
  sensitive: true,
};
// No defaults on purpose: an empty list would carry the plan to the provider's
// "needs at least two subnets" error. Add a Virtual Network to the model and
// these are generated instead of asked for.
const VPC_ID: VariableSpec = {
  name: "vpc_id",
  type: "string",
  description: "VPC the resources are placed in. Add a Virtual Network to the model to generate one.",
};
const PUBLIC_SUBNET_IDS: VariableSpec = {
  name: "public_subnet_ids",
  type: "list(string)",
  description: "Public subnets (two or more) for the load balancer and any public instance.",
};
const PRIVATE_SUBNET_IDS: VariableSpec = {
  name: "private_subnet_ids",
  type: "list(string)",
  description: "Private subnets (two or more) for tasks, caches and databases.",
};

/** The network a consumer joins: the model's, else variables Terraform asks for. */
function netOrVars(net: NetworkRefs | null): { refs: NetworkRefs; variables: VariableSpec[] } {
  if (net) return { refs: net, variables: [] };
  return {
    refs: {
      vpcId: "var.vpc_id",
      publicSubnets: "var.public_subnet_ids",
      privateSubnets: "var.private_subnet_ids",
    },
    variables: [VPC_ID, PUBLIC_SUBNET_IDS, PRIVATE_SUBNET_IDS],
  };
}

/* ---------------------------------------------------------- security groups -- */

/** One rule of a module-managed security group, in the `*_rules` map shape every
 *  terraform-aws-modules module here shares. */
function sgRule(port: string, from: { cidr: string } | { securityGroup: string }): string {
  return mapExpression([
    { key: "from_port", value: port },
    { key: "to_port", value: port },
    { key: "ip_protocol", value: quote("tcp") },
    "cidr" in from
      ? { key: "cidr_ipv4", value: quote(from.cidr) }
      : { key: "referenced_security_group_id", value: from.securityGroup },
  ]);
}

/** Unrestricted egress — what every security group here starts with; ingress is
 *  what the edges add, so a resource nothing points at accepts nothing. */
const EGRESS_ALL = mapExpression([
  {
    key: "all",
    value: mapExpression([
      { key: "ip_protocol", value: quote("-1") },
      { key: "cidr_ipv4", value: quote("0.0.0.0/0") },
    ]),
  },
]);

/* ------------------------------------------------------------ emit helpers -- */

/**
 * Azure resources come from Azure Verified Modules — Microsoft's own maintained
 * module per resource type. They are the Azure half of the same rule the AWS side
 * follows: where a maintained module exists, call it rather than hand-writing the
 * resource. What that buys is the same thing `terraform-aws-modules` buys — the
 * secure defaults, the sub-resources a bare resource block leaves out, and a
 * maintainer who is not us — plus, here, Microsoft's own review of them.
 *
 * The cost is a provider constraint, and it is the reason `azurerm` is pinned to
 * the 4.x line rather than the newest release: the AVM set pins `~> 4.x` / `< 5.1`
 * across its modules and drags in `azapi`, `modtm`, `random` and `time`. That
 * trade was made deliberately — a maintained module on a slightly older provider
 * beats a hand-written resource on the newest one.
 *
 * `enable_telemetry = false` on every call: AVM modules report usage to Microsoft
 * through the `modtm` provider by default, and a generated plan must not opt a
 * customer into that silently.
 */
const RG_MODULE = "module.resource_group";
/** AVM takes the resource group either by name and location, or by the group's
 *  resource id. Which one is the module's choice, not ours. */
const AZ_GROUP = [
  { key: "resource_group_name", value: `${RG_MODULE}.name` },
  { key: "location", value: `${RG_MODULE}.location` },
];
const AZ_PARENT = [
  { key: "parent_id", value: `${RG_MODULE}.resource_id` },
  { key: "location", value: `${RG_MODULE}.location` },
];
/** Every resource in the plan carries the same tag set — see `terraform.ts`. */
const AZ_TAGS = { key: "tags", value: "local.tags" };
const AZ_TELEMETRY = { key: "enable_telemetry", value: "false" };

/**
 * The hardening every Azure kind carries by default. Attribute names are the
 * modules' own inputs, read from the registry rather than remembered, and the emit
 * gate's `terraform validate` is what keeps them so.
 *
 * The rule for what belongs here: on by default when it costs nothing to run and
 * a reviewer would add it first (TLS floors, no anonymous access, key-based auth
 * off), off when it needs a network the model may not have (private endpoints) or
 * would stop a trial being torn down (purge protection is the one exception:
 * Key Vault without it loses secrets to a deleted vault, which is worse).
 *
 * Where a module's own default is already the hardened one it is still written
 * out, because a default can change under a version bump and a stated value
 * cannot.
 */
const AZ_STORAGE_HARDENING = [
  { key: "min_tls_version", value: quote("TLS1_2") },
  { key: "https_traffic_only_enabled", value: "true" },
  { key: "allow_nested_items_to_be_public", value: "false" },
  // Keys off: every caller authenticates as itself through Entra ID, which is
  // what makes the managed identities below worth having.
  { key: "shared_access_key_enabled", value: "false" },
];
/**
 * A storage account the rest of the plan can actually reach. The module's default
 * is a closed firewall, which is right behind a private endpoint and wrong for a
 * plan whose App Service is not VNet-integrated; access is still gated by Entra ID
 * because the shared keys above are disabled.
 */
const AZ_STORAGE_REACHABLE = [
  { key: "public_network_access_enabled", value: "true" },
  {
    key: "network_rules",
    value: mapExpression([
      { key: "bypass", value: `["AzureServices"]` },
      { key: "default_action", value: quote("Allow") },
    ]),
  },
];
/** `site_config` for a web or function app. TLS 1.3 is the module's floor and it
 *  is a higher one than this emitter used to write. */
const AZ_SITE_CONFIG_ENTRIES = [
  { key: "minimum_tls_version", value: quote("1.3") },
  { key: "ftps_state", value: quote("Disabled") },
  { key: "http2_enabled", value: "true" },
];
/** A system-assigned identity, so an app reaches Key Vault and storage without
 *  a secret in its settings. */
const AZ_IDENTITY = {
  key: "managed_identities",
  value: mapExpression([{ key: "system_assigned", value: "true" }]),
};

/**
 * What "Production" buys on a managed database, on either cloud: a standby, a
 * month of retained backups instead of a week, a geo-redundant copy of them, and
 * (on RDS) a final snapshot when it is destroyed.
 *
 * None of these is a security control — encryption, TLS and backups-at-all are on
 * whatever the reviewer picks. These are the settings that cost money or block a
 * `terraform destroy`, which is exactly why they follow a stated choice rather
 * than a default: a trial that cannot be torn down is as wrong as a production
 * database with a week of backups.
 */
function azDbPosture(production: boolean): Array<{ key: string; value: string }> {
  return [
    { key: "backup_retention_days", value: production ? "35" : "7" },
    { key: "geo_redundant_backup_enabled", value: production ? "true" : "false" },
    {
      key: "high_availability",
      value: production
        ? mapExpression([{ key: "mode", value: quote("ZoneRedundant") }])
        : "null",
    },
  ];
}

/**
 * The same choice on RDS, in that provider's spelling — less deletion protection,
 * which RDS gets whatever the reviewer picks: tearing a trial down is one flipped
 * flag, and losing a database to a stray `destroy` is not recoverable at all.
 */
function awsDbPosture(production: boolean): Array<{ key: string; value: string }> {
  return [
    { key: "backup_retention_period", value: production ? "35" : "7" },
    { key: "skip_final_snapshot", value: production ? "false" : "true" },
  ];
}

/**
 * What every RDS instance carries. Encryption at rest is the module's own default
 * and is stated anyway; IAM authentication lets an application connect as its
 * role instead of with the master password; Performance Insights at its free
 * seven-day retention is what a reviewer reaches for first when the database is slow.
 */
const AWS_DB_HARDENING = [
  { key: "storage_encrypted", value: "true" },
  { key: "iam_database_authentication_enabled", value: "true" },
  { key: "deletion_protection", value: "true" },
  { key: "performance_insights_enabled", value: "true" },
  { key: "performance_insights_retention_period", value: "7" },
];

/** `"<prefix>-${var.name_prefix}-<slug>"` — unique per node, readable in the plan. */
function cloudName(prefix: string, slug: string): string {
  return quoteTemplate`${prefix}-\${var.name_prefix}-${slug}`;
}

/**
 * The provider every CloudFront-scoped resource names. CloudFront is global, but
 * the regional pieces that belong to it live in us-east-1 and nowhere else: a
 * CLOUDFRONT-scoped web ACL can only be created there, and so must the log group
 * its logs are delivered to. The plan's own region is wherever everything else
 * is, so these resources take a second, aliased provider — which `emitTerraform`
 * declares only when a block asks for it.
 */
export const AWS_US_EAST_1 = { alias: "us_east_1", region: "us-east-1", ref: "aws.us_east_1" } as const;

/** An AWS managed rule group in a web ACL, enforcing — `override_action { none }`
 *  keeps the group's own block actions rather than counting them. */
function wafManagedRule(slug: string, name: string, group: string, priority: number): HclBlock {
  return block("rule", [], [
    { key: "name", value: quote(name) },
    { key: "priority", value: String(priority) },
  ], [
    block("override_action", [], [], [block("none", [], [])]),
    block("statement", [], [], [
      block("managed_rule_group_statement", [], [
        { key: "name", value: quote(group) },
        { key: "vendor_name", value: quote("AWS") },
      ]),
    ]),
    block("visibility_config", [], [
      { key: "cloudwatch_metrics_enabled", value: "true" },
      { key: "metric_name", value: quote(`${slug}-${name}`) },
      { key: "sampled_requests_enabled", value: "true" },
    ]),
  ]);
}

/**
 * An ACM certificate for `domain`, validated through the plan's own zone. The
 * validation resource is what a consumer references: it completes only once the
 * certificate is issued, so nothing serves the name on a certificate still pending.
 * CloudFront takes its certificate from us-east-1 only, hence the optional provider.
 */
function acmCertificate(domain: CustomDomain, provider?: string): HclBlock[] {
  const onProvider = provider ? { key: "provider", value: provider } : null;
  return [
    block("resource", ["aws_acm_certificate", domain.name], [
      onProvider,
      { key: "domain_name", value: quote(domain.fqdn) },
      { key: "validation_method", value: quote("DNS") },
    ], [
      block("options", [], [{ key: "certificate_transparency_logging_preference", value: quote("ENABLED") }]),
      block("lifecycle", [], [{ key: "create_before_destroy", value: "true" }]),
    ]),
    block("resource", ["aws_route53_record", `${domain.name}_validation`], [
      {
        key: "for_each",
        value: `{ for o in aws_acm_certificate.${domain.name}.domain_validation_options : o.domain_name => o }`,
      },
      { key: "zone_id", value: domain.zoneId },
      { key: "name", value: "each.value.resource_record_name" },
      { key: "type", value: "each.value.resource_record_type" },
      { key: "ttl", value: "300" },
      { key: "records", value: "[each.value.resource_record_value]" },
      { key: "allow_overwrite", value: "true" },
    ]),
    block("resource", ["aws_acm_certificate_validation", domain.name], [
      onProvider,
      { key: "certificate_arn", value: `aws_acm_certificate.${domain.name}.arn` },
      { key: "validation_record_fqdns", value: `[for r in aws_route53_record.${domain.name}_validation : r.fqdn]` },
    ]),
  ];
}

/** No ACL or bucket policy can make an S3 bucket here public. The module's
 *  defaults already say so; stated, because a default can change under a bump. */
const S3_PUBLIC_ACCESS_BLOCK = [
  { key: "block_public_acls", value: "true" },
  { key: "block_public_policy", value: "true" },
  { key: "ignore_public_acls", value: "true" },
  { key: "restrict_public_buckets", value: "true" },
];

/** Default encryption for a bucket: SSE-KMS (with S3 Bucket Keys, which cut the
 *  KMS calls it costs) under `keyArn`, or the AWS-managed key without one — or
 *  S3-managed keys, where KMS cannot be used at all. */
export function s3Encryption(algorithm: "aws:kms" | "AES256", keyArn?: string): { key: string; value: string } {
  return {
    key: "server_side_encryption_configuration",
    value: mapExpression([
      {
        key: "rule",
        value: mapExpression([
          {
            key: "apply_server_side_encryption_by_default",
            value: mapExpression([
              { key: "sse_algorithm", value: quote(algorithm) },
              keyArn ? { key: "kms_master_key_id", value: keyArn } : null,
            ].filter((e) => e !== null)),
          },
          algorithm === "aws:kms" ? { key: "bucket_key_enabled", value: "true" } : null,
        ].filter((e) => e !== null)),
      },
    ]),
  };
}

/** The bucket input that marks an S3 module call as an access-log bucket. */
const ACCESS_LOG_BUCKET_INPUT = "attach_access_log_delivery_policy";

/**
 * A bucket's server access logs — every request, who made it and what it touched —
 * delivered to a bucket of its own, which admits the S3 logging service for this
 * one source bucket and nothing else. The log bucket uses S3-managed keys because
 * that is the only default encryption S3 delivers access logs into.
 */
function s3AccessLogs(c: EmitContext): { logging: { key: string; value: string }; bucket: HclBlock } {
  return s3AccessLogsOf(c.name, c.slug);
}

/** The log bucket of the bucket module `host` whose names carry `slug`, as `s3AccessLogs` writes it. */
function s3AccessLogsOf(host: string, slug: string): { logging: { key: string; value: string }; bucket: HclBlock } {
  const name = `${host}_logs`;
  return {
    logging: {
      key: "logging",
      value: mapExpression([
        { key: "target_bucket", value: `module.${name}.s3_bucket_id` },
        { key: "target_prefix", value: quote("access/") },
      ]),
    },
    bucket: moduleBlock("aws/s3-bucket", name, [
      { key: "bucket", value: cloudName("logs", slug) },
      { key: "control_object_ownership", value: "true" },
      { key: "object_ownership", value: quote("BucketOwnerEnforced") },
      ...S3_PUBLIC_ACCESS_BLOCK,
      { key: "versioning", value: mapExpression([{ key: "enabled", value: "true" }]) },
      s3Encryption("AES256"),
      { key: ACCESS_LOG_BUCKET_INPUT, value: "true" },
      { key: "access_log_delivery_policy_source_buckets", value: `[module.${host}.s3_bucket_arn]` },
    ]),
  };
}

/**
 * Whether an S3 module call is exactly the log bucket the plan adds for a bucket: every input the
 * generator writes and no others, named for the bucket module it logs, which names it as its
 * `logging` target. A bucket that merely takes the access-log policy, or is not the target of one
 * in the file, is a store of the file's own and is drawn.
 */
function isS3LogBucket(b: HclBlock, all: readonly HclBlock[]): boolean {
  const label = b.labels[0] ?? "";
  if (b.type !== "module" || b.labels.length !== 1 || stringValue(attr(b, "source")) !== MODULE_VERSIONS["aws/s3-bucket"].source || !label.endsWith("_logs")) return false;
  const hostName = label.slice(0, -"_logs".length);
  const host = all.find((o) => o.type === "module" && o.labels.length === 1 && o.labels[0] === hostName && stringValue(attr(o, "source")) === MODULE_VERSIONS["aws/s3-bucket"].source);
  const slug = /^"(?:data|site)-\$\{var\.name_prefix\}-([a-z0-9-]+)"$/.exec(squash(attr(host ?? b, "bucket")))?.[1];
  if (host === undefined || attr(host, ACCESS_LOG_BUCKET_INPUT) !== undefined || slug === undefined) return false;
  const expected = s3AccessLogsOf(hostName, slug);
  return sameAttributes(b, expected.bucket) && squash(attr(host, "logging")) === squash(expected.logging.value);
}

/**
 * The ALB's listeners. Without a certificate there is nothing to terminate TLS
 * with — the only name the balancer has is the `*.elb.amazonaws.com` one AWS
 * assigns, which no public certificate covers — so it forwards plain HTTP. With
 * one, HTTPS forwards (on the module's TLS 1.3 policy) and HTTP only redirects.
 */
function albListeners(certificateArn?: string): string {
  const forward = { key: "forward", value: mapExpression([{ key: "target_group_key", value: quote("app") }]) };
  if (!certificateArn) {
    return mapExpression([
      { key: "http", value: mapExpression([{ key: "port", value: "80" }, { key: "protocol", value: quote("HTTP") }, forward]) },
    ]);
  }
  return mapExpression([
    {
      key: "http",
      value: mapExpression([
        { key: "port", value: "80" },
        { key: "protocol", value: quote("HTTP") },
        {
          key: "redirect",
          value: mapExpression([
            { key: "port", value: quote("443") },
            { key: "protocol", value: quote("HTTPS") },
            { key: "status_code", value: quote("HTTP_301") },
          ]),
        },
      ]),
    },
    {
      key: "https",
      value: mapExpression([
        { key: "port", value: "443" },
        { key: "protocol", value: quote("HTTPS") },
        { key: "certificate_arn", value: certificateArn },
        forward,
      ]),
    },
  ]);
}

/** WAF only delivers to a log group whose name carries this prefix — which is also
 *  what tells the WAF's log group apart from a monitoring one when a plan is read back. */
const WAF_LOG_PREFIX = "aws-waf-logs";

/** Azure storage account names are 3–24 lowercase alphanumerics — enforce it in HCL. */
function storageName(slug: string): string {
  return `substr(lower(replace("st\${var.name_prefix}${slug}", "-", "")), 0, 24)`;
}

function tagsBlock(slug: string): { key: string; value: string } {
  return {
    key: "tags",
    value: mapExpression([
      { key: "Name", value: quote(slug) },
      { key: "ManagedBy", value: quote("diagram") },
    ]),
  };
}

/**
 * Point a Front Door profile at one origin. The module takes the origin group,
 * the origin and the route that publishes it as three maps keyed by the same
 * string, and it is that shared key that ties them together — so they are written
 * in one place rather than three, by both the edge wiring and the fallback below.
 */
export function frontDoorOrigin(
  host: HclBlock,
  key: string,
  name: string,
  hostname: string,
): void {
  addMapEntry(host, "front_door_origin_groups", {
    key,
    value: mapExpression([
      { key: "name", value: name },
      { key: "load_balancing", value: mapExpression([{ key: "default", value: "{}" }]) },
    ]),
  });
  addMapEntry(host, "front_door_origins", {
    key,
    value: mapExpression([
      { key: "name", value: name },
      { key: "origin_group_key", value: quote(key) },
      { key: "host_name", value: hostname },
      { key: "certificate_name_check_enabled", value: "true" },
    ]),
  });
  addMapEntry(host, "front_door_routes", {
    key,
    value: mapExpression([
      { key: "name", value: name },
      { key: "origin_group_key", value: quote(key) },
      { key: "origin_keys", value: `[${quote(key)}]` },
      { key: "endpoint_key", value: quote("default") },
      { key: "forwarding_protocol", value: quote("HttpsOnly") },
      { key: "supported_protocols", value: `["Http", "Https"]` },
      { key: "patterns_to_match", value: `["/*"]` },
    ]),
  });
}

/** The profile's one security policy: its WAF over the default endpoint and over
 *  every custom domain the plan's zone has given it. */
function frontDoorSecurityPolicies(slug: string, domainKeys: readonly string[]): string {
  return mapExpression([
    {
      key: "default",
      value: mapExpression([
        { key: "name", value: cloudName("fdsp", slug) },
        {
          key: "firewall",
          value: mapExpression([
            { key: "front_door_firewall_policy_key", value: quote("default") },
            {
              key: "association",
              value: mapExpression([
                domainKeys.length > 0 ? { key: "domain_keys", value: `[${domainKeys.map(quote).join(", ")}]` } : null,
                { key: "endpoint_keys", value: `["default"]` },
                { key: "patterns_to_match", value: `["/*"]` },
              ].filter((e) => e !== null)),
            },
          ]),
        },
      ]),
    },
  ]);
}

/* ------------------------------------------------------------------ kinds -- */

/** The registry modules a Google Cloud file's module call reverse-maps through: sources only, since Terragram pins and writes no Google module. */
const GCP_MODULES = {
  dns: "terraform-google-modules/cloud-dns/google",
  loadBalancer: "terraform-google-modules/lb-http/google",
  cloudRun: "GoogleCloudPlatform/cloud-run/google",
  bucket: "terraform-google-modules/cloud-storage/google",
  pubsub: "terraform-google-modules/pubsub/google",
  network: "terraform-google-modules/network/google",
  postgres: "GoogleCloudPlatform/sql-db/google//modules/postgresql",
  mysql: "GoogleCloudPlatform/sql-db/google//modules/mysql",
  serviceAccounts: "terraform-google-modules/service-accounts/google",
  kms: "terraform-google-modules/kms/google",
  gke: "terraform-google-modules/kubernetes-engine/google",
  bigquery: "terraform-google-modules/bigquery/google",
  project: "terraform-google-modules/project-factory/google",
} as const;

/** The types a Google front end is made of, whether it is a load balancer or the CDN in front of an application. */
const GCP_FRONTEND_TYPES = [
  "google_compute_global_forwarding_rule",
  "google_compute_global_address",
  "google_compute_url_map",
  "google_compute_target_http_proxy",
  "google_compute_target_https_proxy",
  "google_compute_backend_service",
  "google_compute_backend_bucket",
  "google_compute_managed_ssl_certificate",
  "google_compute_ssl_policy",
  "google_compute_region_network_endpoint_group",
  "google_compute_global_network_endpoint_group",
];

/** A storage bucket that serves a site: a `website` block (the resource) or input (a module). */
function hasWebsite(b: HclBlock): boolean {
  return b.blocks.some((x) => x.type === "website") || attr(b, "website") !== undefined;
}

/** The plan a Google Cloud kind asks things of; `terraform.ts` supplies it, and a context built without one asks nothing. */
function gcpPlan(c: EmitContext): GcpPlan {
  return c.gcp ?? { api: () => undefined, privateServices: () => "", position: 0 };
}

/** A block nested under `b` by the labels in `path`, the first of each. */
function childBlock(b: HclBlock, ...path: string[]): HclBlock | undefined {
  let at: HclBlock | undefined = b;
  for (const type of path) at = at?.blocks.find((x) => x.type === type);
  return at;
}

/** Cloud Run takes its environment as repeated `env` blocks of the container, not a map. */
function appendRunEnv(host: HclBlock, entry: { key: string; value: string }): void {
  const template = host.blocks.find((x) => x.type === "template");
  const container = template?.blocks.find((x) => x.type === "containers");
  if (!container) return;
  container.blocks.push(block("env", [], [
    { key: "name", value: quote(entry.key) },
    { key: "value", value: entry.value },
  ]));
}

export const KIND_DEFINITIONS: readonly KindDefinition[] = [
  {
    kind: "internet",
    category: "edge",
    label: "Internet",
    role: "conceptual",
    order: 0,
    keywords: [],
    fields: [],
    azure: null,
    aws: null,
  },

  {
    kind: "external",
    category: "edge",
    label: "Untranslated block",
    role: "external",
    keywords: [],
    fields: [],
    azure: null,
    aws: null,
  },

  {
    kind: "dns",
    category: "network",
    label: "DNS Zone",
    role: "ingress",
    order: 1,
    keywords: ["dns", "domain", "route 53", "route53", "hostname", "zone"],
    fields: [DNS_ZONE_FIELD],
    azure: {
      type: "azurerm_dns_zone",
      moduleSource: MODULE_VERSIONS["azure/dns-zone"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/dns-zone", c.name, [
            { key: "name", value: quote(c.attr("Zone name")) },
            { key: "resource_group_name", value: `${RG_MODULE}.name` },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_name_servers`, value: `module.${c.name}.name_servers` }],
      }),
      read: (b) => readOne(b, "name", "Zone name", (v) => v),
    },
    aws: {
      type: "aws_route53_zone",
      moduleSource: MODULE_VERSIONS["aws/route53"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("aws/route53", c.name, [{ key: "name", value: quote(c.attr("Zone name")) }]),
        ],
        outputs: [{ name: `${c.name}_name_servers`, value: `module.${c.name}.name_servers` }],
      }),
      read: (b) => readOne(b, "name", "Zone name", (v) => v),
      hostname: (ref) => refAddress(ref, "name"),
    },
    gcp: {
      type: "google_dns_managed_zone",
      matches: ["google_dns_record_set"],
      moduleSource: GCP_MODULES.dns,
      emit: (c) => GCP.dns.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) => readOne(b, "dns_name", "Zone name", (v) => (/^[A-Za-z0-9.-]{1,120}$/.test(v) ? withoutTrailingDot(v) : undefined)),
    },
  },

  {
    kind: "front-door",
    category: "network",
    label: "Front Door + WAF",
    role: "ingress",
    order: 2,
    keywords: ["waf", "front door", "cdn", "firewall", "edge", "cloudfront"],
    fields: [],
    azure: {
      type: "azurerm_cdn_frontdoor_profile",
      matches: ["azurerm_frontdoor", "azurerm_cdn_frontdoor_endpoint"],
      moduleSource: MODULE_VERSIONS["azure/cdn-profile"].source,
      // Premium is what the Microsoft-managed rule sets require, and a profile
      // named "Front Door + WAF" that carries no rules is a WAF in name only —
      // the policy and the security policy that binds it to the endpoint are the
      // whole reason this tier exists. Origins and routes arrive with the edges.
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/cdn-profile", c.name, [
            { key: "name", value: cloudName("fd", c.slug) },
            ...AZ_GROUP,
            { key: "sku", value: quote("Premium_AzureFrontDoor") },
            {
              key: "front_door_endpoints",
              value: mapExpression([
                {
                  key: "default",
                  value: mapExpression([{ key: "name", value: cloudName("fde", c.slug) }]),
                },
              ]),
            },
            {
              key: "front_door_firewall_policies",
              value: mapExpression([
                {
                  key: "default",
                  value: mapExpression([
                    // A firewall policy name is alphanumeric only — no hyphens.
                    { key: "name", value: `replace(${cloudName("waf", c.slug)}, "-", "")` },
                    { key: "resource_group_name", value: `${RG_MODULE}.name` },
                    { key: "sku_name", value: quote("Premium_AzureFrontDoor") },
                    { key: "mode", value: quote("Prevention") },
                    {
                      key: "managed_rules",
                      value: mapExpression([
                        {
                          key: "default",
                          value: mapExpression([
                            { key: "type", value: quote("Microsoft_DefaultRuleSet") },
                            { key: "version", value: quote("2.1") },
                            { key: "action", value: quote("Block") },
                          ]),
                        },
                      ]),
                    },
                  ]),
                },
              ]),
            },
            { key: "front_door_security_policies", value: frontDoorSecurityPolicies(c.slug, []) },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [
          {
            name: `${c.name}_hostname`,
            value: `module.${c.name}.frontdoor_endpoints["default"].host_name`,
          },
        ],
      }),
      // A route with no origin publishes nothing. When the model has not put
      // anything behind the CDN the origin is a variable the reviewer fills in,
      // stated in the plan rather than invented.
      finalize: (host, c) => {
        const variables: VariableSpec[] = [];
        if (!host.attributes.some((a) => a.key === "front_door_origins")) {
          frontDoorOrigin(host, `${c.slug}-origin`, cloudName("origin", c.slug), "var.origin_domain_name");
          variables.push({
            name: "origin_domain_name",
            type: "string",
            description: "Hostname the CDN fronts — nothing in the model sits behind it yet.",
            default: quote(""),
          });
        }
        // A custom domain is served only by the routes that name it, and the WAF
        // inspects only the domains its security policy is associated with — so
        // once the zone has added one, every route and the policy take it on.
        const domains = mapEntries(attr(host, "front_door_custom_domains")).map((e) => e.key);
        if (domains.length > 0) {
          const keys = `[${domains.map(quote).join(", ")}]`;
          for (const a of host.attributes) {
            if (a.key === "front_door_routes") {
              a.value = mapExpression(
                mapEntries(a.value).map((route) => ({
                  key: route.key,
                  value: mapExpression([...mapEntries(route.value), { key: "custom_domain_keys", value: keys }]),
                })),
              );
            }
            if (a.key === "front_door_security_policies") a.value = frontDoorSecurityPolicies(c.slug, domains);
          }
        }
        return variables;
      },
      // Front Door issues and renews the certificate itself once it has seen the
      // validation token in the zone; the zone's `www` CNAME then reaches a route
      // that answers for that name.
      customDomain: (host, domain) => {
        addMapEntry(host, "front_door_custom_domains", {
          key: domain.name,
          value: mapExpression([
            // A custom domain's resource name allows letters, digits and hyphens.
            { key: "name", value: quote(domain.fqdn.replace(/\./g, "-")) },
            { key: "dns_zone_id", value: domain.zoneId },
            { key: "host_name", value: quote(domain.fqdn) },
            { key: "tls", value: mapExpression([{ key: "certificate_type", value: quote("ManagedCertificate") }]) },
          ]),
        });
        addMapEntry(domain.zone, "txt_records", {
          key: `${domain.name}_validation`,
          value: mapExpression([
            { key: "name", value: quote(`_dnsauth.${domain.record}`) },
            { key: "resource_group_name", value: `${RG_MODULE}.name` },
            { key: "zone_name", value: quote(domain.zoneName) },
            { key: "ttl", value: "3600" },
            {
              key: "records",
              value: mapExpression([
                {
                  key: "token",
                  value: mapExpression([
                    {
                      key: "value",
                      value: `module.${host.labels[0]}.frontdoor_custom_domains[${quote(domain.name)}].validation_token`,
                    },
                  ]),
                },
              ]),
            },
          ]),
        });
        return [];
      },
      hostname: (ref) => `module.${ref.name}.frontdoor_endpoints["default"].host_name`,
    },
    aws: {
      type: "aws_cloudfront_distribution",
      matches: [
        "aws_wafv2_web_acl",
        "aws_wafv2_web_acl_logging_configuration",
        "aws_cloudwatch_log_group",
        "aws_acm_certificate",
        "aws_acm_certificate_validation",
        "aws_cloudfront_origin_access_control",
      ],
      // A log group is monitoring's own type; only the WAF's — named with the
      // prefix WAF requires — belongs to the edge. Likewise a certificate is the
      // edge's only when it is issued where CloudFront reads it from.
      matchBlock: (b) => {
        if (b.labels[0] === "aws_cloudwatch_log_group") {
          return stringValue(attr(b, "name"))?.startsWith(`${WAF_LOG_PREFIX}-`) ?? false;
        }
        if (b.labels[0]?.startsWith("aws_acm_certificate")) return attr(b, "provider") === AWS_US_EAST_1.ref;
        return true;
      },
      emit: (c) => ({
        blocks: [
          block("resource", ["aws_wafv2_web_acl", c.name], [
            { key: "provider", value: AWS_US_EAST_1.ref },
            { key: "name", value: cloudName("waf", c.slug) },
            { key: "scope", value: quote("CLOUDFRONT") },
          ], [
            block("default_action", [], [], [block("allow", [], [])]),
            // Allow-by-default with no rules is a WAF in name only. The AWS common
            // rule set is the baseline every reviewer would ask for first; known
            // bad inputs is the one that blocks Log4Shell (CVE-2021-44228) probes.
            wafManagedRule(c.slug, "aws-common", "AWSManagedRulesCommonRuleSet", 1),
            wafManagedRule(c.slug, "aws-known-bad-inputs", "AWSManagedRulesKnownBadInputsRuleSet", 2),
            block("visibility_config", [], [
              { key: "cloudwatch_metrics_enabled", value: "true" },
              { key: "metric_name", value: quote(c.slug) },
              { key: "sampled_requests_enabled", value: "true" },
            ]),
          ]),
          block("resource", ["aws_cloudfront_distribution", c.name], [
            { key: "enabled", value: "true" },
            { key: "web_acl_id", value: `aws_wafv2_web_acl.${c.name}.arn` },
          ], [
            block("viewer_certificate", [], [
              { key: "cloudfront_default_certificate", value: "true" },
            ]),
            block("restrictions", [], [], [
              block("geo_restriction", [], [{ key: "restriction_type", value: quote("none") }]),
            ]),
          ]),
          // HSTS, nosniff, frame and referrer headers on every response, from the
          // AWS-managed policy rather than a copy of it that would drift.
          block("data", ["aws_cloudfront_response_headers_policy", `${c.name}_security_headers`], [
            { key: "name", value: quote("Managed-SecurityHeadersPolicy") },
          ]),
          // Every request crosses the web ACL, so its log is the edge's request
          // log: what was asked for, from where, and which rule let it through.
          block("resource", ["aws_cloudwatch_log_group", `${c.name}_waf`], [
            { key: "provider", value: AWS_US_EAST_1.ref },
            { key: "name", value: cloudName(WAF_LOG_PREFIX, c.slug) },
            { key: "retention_in_days", value: "365" },
          ]),
          block("resource", ["aws_wafv2_web_acl_logging_configuration", c.name], [
            { key: "provider", value: AWS_US_EAST_1.ref },
            { key: "resource_arn", value: `aws_wafv2_web_acl.${c.name}.arn` },
            { key: "log_destination_configs", value: `[aws_cloudwatch_log_group.${c.name}_waf.arn]` },
          ]),
        ],
        referent: 1,
        consumer: 1,
        variables: [NAME_PREFIX],
        outputs: [
          {
            name: `${c.name}_domain`,
            value: `aws_cloudfront_distribution.${c.name}.domain_name`,
          },
        ],
      }),
      // A distribution is only valid with an origin and a default behaviour that
      // names it. The origin comes from the edge to whatever the CDN fronts; when
      // nothing is behind it the origin is a variable the reviewer must fill in,
      // stated in the plan rather than invented.
      finalize: (host, c) => {
        const variables: VariableSpec[] = [];
        let origins = host.blocks.filter((b) => b.type === "origin");
        if (origins.length === 0) {
          host.blocks.push(
            block("origin", [], [
              { key: "domain_name", value: "var.origin_domain_name" },
              { key: "origin_id", value: quote(`${c.slug}-origin`) },
            ], [
              block("custom_origin_config", [], [
                { key: "http_port", value: "80" },
                { key: "https_port", value: "443" },
                { key: "origin_protocol_policy", value: quote("https-only") },
                { key: "origin_ssl_protocols", value: `["TLSv1.2"]` },
              ]),
            ]),
          );
          variables.push({
            name: "origin_domain_name",
            type: "string",
            description: "Hostname the CDN fronts — nothing in the model sits behind it yet.",
            default: quote(""),
          });
          origins = host.blocks.filter((b) => b.type === "origin");
        }
        if (!host.blocks.some((b) => b.type === "default_cache_behavior")) {
          const first = origins[0]?.attributes.find((a) => a.key === "origin_id")?.value ?? quote("origin");
          host.blocks.push(
            block("default_cache_behavior", [], [
              { key: "target_origin_id", value: first },
              { key: "viewer_protocol_policy", value: quote("redirect-to-https") },
              { key: "allowed_methods", value: `["GET", "HEAD", "OPTIONS"]` },
              { key: "cached_methods", value: `["GET", "HEAD"]` },
              {
                key: "response_headers_policy_id",
                value: `data.aws_cloudfront_response_headers_policy.${c.name}_security_headers.id`,
              },
            ], [
              block("forwarded_values", [], [{ key: "query_string", value: "false" }], [
                block("cookies", [], [{ key: "forward", value: quote("none") }]),
              ]),
            ]),
          );
        }
        return variables;
      },
      // The zone's name on the distribution, on a certificate of its own: a CNAME
      // to a distribution that does not list the name as an alias is refused by
      // CloudFront, and the default certificate covers *.cloudfront.net only.
      customDomain: (host, domain) => {
        host.attributes.push({ key: "aliases", value: `[${quote(domain.fqdn)}]` });
        const viewer = host.blocks.find((b) => b.type === "viewer_certificate");
        if (viewer) {
          viewer.attributes = [
            { key: "acm_certificate_arn", value: `aws_acm_certificate_validation.${domain.name}.certificate_arn` },
            { key: "ssl_support_method", value: quote("sni-only") },
            { key: "minimum_protocol_version", value: quote("TLSv1.2_2021") },
          ];
        }
        return acmCertificate(domain, AWS_US_EAST_1.ref);
      },
      hostname: (ref) => `aws_cloudfront_distribution.${ref.name}.domain_name`,
    },
    gcp: {
      type: "google_compute_security_policy",
      matches: GCP_FRONTEND_TYPES,
      matchBlock: isEdgeBlock,
      emit: (c) => GCP.frontDoor.emit({ ...c, gcp: gcpPlan(c) }),
      finalize: (host) => finalizeFrontend(host),
      customDomain: (host, domain, blocks) =>
        GCP.frontDoor.domain({ name: host.labels[1] ?? "", slug: (host.labels[1] ?? "").replace(/_/g, "-") }, domain, blocks),
      addressResource: (ref) => `google_compute_global_address.${ref.name}.address`,
    },
  },

  {
    kind: "load-balancer",
    category: "network",
    label: "Load Balancer",
    role: "ingress",
    order: 3,
    keywords: ["load balancer", "load-balancer", "application gateway", "alb", "elb", "ingress"],
    fields: [],
    azure: {
      type: "azurerm_lb",
      matches: ["azurerm_application_gateway", "azurerm_lb_backend_address_pool"],
      moduleSource: MODULE_VERSIONS["azure/load-balancer"].source,
      // The module owns the public address the balancer answers on, which a bare
      // azurerm_lb leaves to a second resource the reviewer has to remember.
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/load-balancer", c.name, [
            { key: "name", value: cloudName("lb", c.slug) },
            ...AZ_GROUP,
            { key: "sku", value: quote("Standard") },
            {
              key: "frontend_ip_configurations",
              value: mapExpression([
                {
                  key: "public",
                  value: mapExpression([
                    { key: "name", value: quote("public") },
                    { key: "create_public_ip_address", value: "true" },
                    { key: "new_public_ip_resource_group_name", value: `${RG_MODULE}.name` },
                    { key: "new_public_ip_location", value: `${RG_MODULE}.location` },
                  ]),
                },
              ]),
            },
            {
              key: "backend_address_pools",
              value: mapExpression([
                { key: "backend", value: mapExpression([{ key: "name", value: quote("backend") }]) },
              ]),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [
          {
            name: `${c.name}_ip`,
            value: `module.${c.name}.azurerm_public_ip["public"].ip_address`,
          },
        ],
      }),
      hostname: (ref) => `module.${ref.name}.azurerm_public_ip["public"].ip_address`,
      addressResource: (ref) => `module.${ref.name}.azurerm_public_ip["public"].id`,
    },
    aws: {
      type: "aws_lb",
      matches: ["aws_lb_target_group", "aws_lb_listener", "aws_elb"],
      moduleSource: MODULE_VERSIONS["aws/alb"].source,
      // The module owns the listener, the target group, and the security group a
      // bare aws_lb leaves out — an ALB with no listener serves nothing. The one
      // target group is `app`, IP-typed so Fargate tasks and instances both fit;
      // whatever the edge points at registers itself (see terraform.ts).
      emit: (c) => {
        const { refs, variables } = netOrVars(c.net);
        return {
          blocks: [
            moduleBlock("aws/alb", c.name, [
              { key: "name", value: cloudName("lb", c.slug) },
              { key: "vpc_id", value: refs.vpcId },
              { key: "subnets", value: refs.publicSubnets },
              { key: "enable_deletion_protection", value: "false" },
              { key: "drop_invalid_header_fields", value: "true" },
              {
                key: "security_group_ingress_rules",
                value: mapExpression([
                  { key: "http", value: sgRule("80", { cidr: "0.0.0.0/0" }) },
                  { key: "https", value: sgRule("443", { cidr: "0.0.0.0/0" }) },
                ]),
              },
              // No egress of its own: a balancer only ever talks to its targets,
              // and each target the edges register opens exactly that path.
              { key: "listeners", value: albListeners() },
              {
                key: "target_groups",
                value: mapExpression([
                  {
                    key: "app",
                    value: mapExpression([
                      { key: "name_prefix", value: quote("app-") },
                      { key: "protocol", value: quote("HTTP") },
                      { key: "port", value: "80" },
                      { key: "target_type", value: quote("ip") },
                      { key: "create_attachment", value: "false" },
                      {
                        key: "health_check",
                        value: mapExpression([
                          { key: "enabled", value: "true" },
                          { key: "path", value: quote("/") },
                          { key: "matcher", value: quote("200-399") },
                        ]),
                      },
                    ]),
                  },
                ]),
              },
            ]),
          ],
          variables: [NAME_PREFIX, ...variables],
          outputs: [{ name: `${c.name}_dns`, value: `module.${c.name}.dns_name` }],
        };
      },
      // With a name of its own the balancer terminates TLS for it, and plain HTTP
      // only redirects there.
      customDomain: (host, domain) => {
        const listeners = host.attributes.find((a) => a.key === "listeners");
        if (listeners) listeners.value = albListeners(`aws_acm_certificate_validation.${domain.name}.certificate_arn`);
        return acmCertificate(domain);
      },
      hostname: (ref) => refAddress(ref, "dns_name"),
    },
    gcp: {
      type: "google_compute_global_forwarding_rule",
      matches: [
        ...GCP_FRONTEND_TYPES,
        "google_compute_forwarding_rule",
        "google_compute_region_url_map",
        "google_compute_region_backend_service",
        "google_compute_health_check",
        "google_compute_region_health_check",
      ],
      // What the front door claims (its own balancer is named apart, see `isEdgeBlock`) is decided before this kind sees a block.
      moduleSource: GCP_MODULES.loadBalancer,
      emit: (c) => GCP.loadBalancer.emit({ ...c, gcp: gcpPlan(c) }),
      finalize: (host) => finalizeFrontend(host),
      customDomain: (host, domain, blocks) =>
        GCP.loadBalancer.domain({ name: host.labels[1] ?? "", slug: (host.labels[1] ?? "").replace(/_/g, "-") }, domain, blocks),
      addressResource: (ref) => `google_compute_global_address.${ref.name}.address`,
    },
  },

  {
    kind: "app-service",
    category: "compute",
    label: "App Service",
    role: "serving",
    keywords: ["web app", "web tier", "app service", "api", "website", "web", "app", "service"],
    fields: [APP_TIER_FIELD],
    azure: {
      type: "azurerm_linux_web_app",
      matches: ["azurerm_service_plan", "azurerm_app_service", "azurerm_windows_web_app"],
      moduleSource: MODULE_VERSIONS["azure/web-site"].source,
      moduleMatches: [MODULE_VERSIONS["azure/service-plan"].source],
      // One module serves both App Service kinds, so the `kind` input is what
      // separates a web app from a function app when reading a plan back.
      matchBlock: (b) => b.type !== "module" || stringValue(attr(b, "kind")) !== "functionapp",
      emit: (c) => {
        const tier = c.attr("Compute tier");
        // Zone balancing needs a Premium v3 plan; the Dev / Test SKU cannot do it,
        // and asking for it there fails at apply.
        const spread = tier !== "Dev / Test";
        return {
          blocks: [
            moduleBlock("azure/service-plan", `${c.name}_plan`, [
              { key: "name", value: cloudName("asp", c.slug) },
              ...AZ_PARENT,
              { key: "os_type", value: quote("Linux") },
              { key: "sku_name", value: quote(APP_TIER_AZURE.to(tier, "Standard (P1v3)")) },
              { key: "worker_count", value: spread ? "3" : "1" },
              { key: "zone_balancing_enabled", value: spread ? "true" : "false" },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
            moduleBlock("azure/web-site", c.name, [
              { key: "name", value: cloudName("app", c.slug) },
              ...AZ_PARENT,
              { key: "kind", value: quote("webapp") },
              { key: "os_type", value: quote("Linux") },
              { key: "service_plan_resource_id", value: `module.${c.name}_plan.resource_id` },
              { key: "https_only", value: "true" },
              // A web tier the internet cannot reach is not a web tier; the
              // module defaults this closed for private-endpoint deployments.
              { key: "public_network_access_enabled", value: "true" },
              // Outbound into the plan's network, which is the only way to the
              // vault's and the databases' private endpoints.
              c.private
                ? { key: "virtual_network_subnet_id", value: c.private.subnet(c.slug, "Microsoft.Web/serverFarms") }
                : null,
              AZ_IDENTITY,
              { key: "site_config", value: mapExpression(AZ_SITE_CONFIG_ENTRIES) },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
          ],
          referent: 1,
          consumer: 1,
          variables: [NAME_PREFIX],
          outputs: [{ name: `${c.name}_hostname`, value: `module.${c.name}.resource_uri` }],
        };
      },
      settings: { blockIndex: 1, attribute: "app_settings" },
      hostname: (ref) => `module.${ref.name}.resource_uri`,
    },
    aws: {
      type: "aws_instance",
      matches: ["aws_elastic_beanstalk_environment"],
      moduleSource: MODULE_VERSIONS["aws/ec2-instance"].source,
      // The module resolves a current Amazon Linux AMI from SSM, so no AMI id is
      // asked for; IMDSv2, an encrypted root volume and an SSM-capable instance
      // profile are what a reviewer would add first, so they are on by default.
      // Public subnet with a public address: this tier sits directly behind the
      // CDN when no load balancer is in the model.
      emit: (c) => {
        const { refs, variables } = netOrVars(c.net);
        return {
          blocks: [
            moduleBlock("aws/ec2-instance", c.name, [
              { key: "name", value: cloudName("web", c.slug) },
              {
                key: "instance_type",
                value: quote(APP_TIER_AWS.to(c.attr("Compute tier"), "Standard (P1v3)")),
              },
              { key: "subnet_id", value: `${refs.publicSubnets}[0]` },
              { key: "associate_public_ip_address", value: "true" },
              { key: "security_group_vpc_id", value: refs.vpcId },
              {
                key: "security_group_ingress_rules",
                value: mapExpression([
                  { key: "http", value: sgRule("80", { cidr: "0.0.0.0/0" }) },
                  { key: "https", value: sgRule("443", { cidr: "0.0.0.0/0" }) },
                ]),
              },
              { key: "security_group_egress_rules", value: EGRESS_ALL },
              { key: "monitoring", value: "true" },
              {
                key: "metadata_options",
                value: mapExpression([
                  { key: "http_endpoint", value: quote("enabled") },
                  { key: "http_tokens", value: quote("required") },
                ]),
              },
              {
                key: "root_block_device",
                value: mapExpression([
                  { key: "encrypted", value: "true" },
                  { key: "type", value: quote("gp3") },
                ]),
              },
              { key: "create_iam_instance_profile", value: "true" },
              {
                key: "iam_role_policies",
                value: mapExpression([
                  { key: "ssm", value: quote("arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore") },
                ]),
              },
              tagsBlock(c.slug),
            ]),
          ],
          variables: [NAME_PREFIX, ...variables],
          outputs: [{ name: `${c.name}_public_dns`, value: `module.${c.name}.public_dns` }],
        };
      },
      read: (b) =>
        readOne(b, "instance_type", "Compute tier", (v) => APP_TIER_AWS.from(v)),
      hostname: (ref) => refAddress(ref, "public_dns"),
    },
    gcp: {
      type: "google_app_engine_standard_app_version",
      matches: ["google_app_engine_flexible_app_version", "google_app_engine_application", "google_app_engine_service_network_settings"],
      emit: (c) => GCP.appService.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) => readOne(b, "instance_class", "Compute tier", (v) => appEngineClassFrom(v)),
      settings: { attribute: "env_variables" },
      hostname: (ref) => `google_app_engine_application.${ref.name}.default_hostname`,
    },
  },

  {
    kind: "containers",
    category: "compute",
    label: "Containers",
    role: "serving",
    flag: { reason: "Container orchestrator and sizing were not specified — confirm before generating." },
    keywords: ["container", "containers", "containerised", "containerized", "docker", "kubernetes", "aks", "eks", "ecs", "fargate"],
    fields: [CONTAINER_SIZE_FIELD],
    azure: {
      type: "azurerm_container_app",
      matches: ["azurerm_container_app_environment", "azurerm_kubernetes_cluster"],
      moduleSource: MODULE_VERSIONS["azure/container-app"].source,
      moduleMatches: [MODULE_VERSIONS["azure/container-environment"].source],
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/container-environment", `${c.name}_environment`, [
            { key: "name", value: cloudName("cae", c.slug) },
            ...AZ_GROUP,
            { key: "zone_redundant", value: "false" },
            // A workload-profiles environment in its own subnet of the plan's
            // network: it reaches the private endpoints, and its ingress stays
            // public (`internal = false`) so an edge can front it.
            {
              key: "workload_profiles",
              value: `[{ name = "Consumption", workload_profile_type = "Consumption" }]`,
            },
            c.private
              ? {
                  key: "vnet_configuration",
                  value: mapExpression([
                    {
                      key: "infrastructure_subnet_id",
                      // The environment's own outbound (image pulls) leaves from here.
                      value: c.private.subnet(c.slug, "Microsoft.App/environments", true),
                    },
                    { key: "internal", value: "false" },
                  ]),
                }
              : null,
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
          moduleBlock("azure/container-app", c.name, [
            { key: "name", value: cloudName("ca", c.slug) },
            { key: "resource_group_name", value: `${RG_MODULE}.name` },
            {
              key: "container_app_environment_resource_id",
              value: `module.${c.name}_environment.resource_id`,
            },
            { key: "revision_mode", value: quote("Single") },
            {
              key: "template",
              value: mapExpression([
                {
                  key: "containers",
                  value: `[{ name = ${quote(c.slug)}, image = "mcr.microsoft.com/k8se/quickstart:latest", cpu = ${CONTAINER_SIZE_AZURE.to(c.attr("Container size"), "Medium (1 vCPU)")}, memory = "2Gi" }]`,
                },
              ]),
            },
            // Without ingress the app has no address, so nothing can be put in
            // front of it and the revision FQDN below would never resolve.
            {
              key: "ingress",
              value: mapExpression([
                { key: "external_enabled", value: "true" },
                { key: "target_port", value: "80" },
                { key: "traffic_weight", value: `[{ percentage = 100, latest_revision = true }]` },
              ]),
            },
            AZ_IDENTITY,
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        referent: 1,
        consumer: 1,
        variables: [NAME_PREFIX],
      }),
      // The module returns the revision FQDN already prefixed with the scheme;
      // everything that consumes a hostname wants the bare host.
      hostname: (ref) => `trimprefix(module.${ref.name}.latest_revision_fqdn, "https://")`,
    },
    aws: {
      type: "aws_ecs_service",
      matches: ["aws_ecs_cluster", "aws_ecs_task_definition", "aws_eks_cluster"],
      moduleSource: `${MODULE_VERSIONS["aws/ecs"].source}//modules/service`,
      moduleMatches: [`${MODULE_VERSIONS["aws/ecs"].source}//modules/cluster`],
      // The service module owns what the raw trio left out — execution and task
      // roles, the log group, the security group — and is where a load balancer
      // registers (`load_balancer`, added by the edge). Tasks sit in private
      // subnets; nothing reaches them except what an edge lets in.
      emit: (c) => {
        const { refs, variables } = netOrVars(c.net);
        const cpu = CONTAINER_SIZE_AWS.to(c.attr("Container size"), "Medium (1 vCPU)");
        return {
          blocks: [
            moduleBlock("aws/ecs", `${c.name}_cluster`, [
              { key: "name", value: cloudName("ecs", c.slug) },
            ], "modules/cluster"),
            moduleBlock("aws/ecs", c.name, [
              { key: "name", value: cloudName("svc", c.slug) },
              { key: "cluster_arn", value: `module.${c.name}_cluster.arn` },
              { key: "cpu", value: cpu },
              { key: "memory", value: "2048" },
              { key: "desired_count", value: "2" },
              { key: "subnet_ids", value: refs.privateSubnets },
              { key: "security_group_egress_rules", value: EGRESS_ALL },
              {
                key: "container_definitions",
                value: mapExpression([
                  {
                    key: "app",
                    value: mapExpression([
                      { key: "image", value: quote("public.ecr.aws/nginx/nginx:latest") },
                      { key: "port_mappings", value: `[{ name = "http", containerPort = 80, protocol = "tcp" }]` },
                      { key: "readonly_root_filesystem", value: "false" },
                      { key: "enable_cloudwatch_logging", value: "true" },
                    ]),
                  },
                ]),
              },
            ], "modules/service"),
          ],
          referent: 1,
          consumer: 1,
          variables: [NAME_PREFIX, ...variables],
        };
      },
      read: (b) =>
        readOne(b, "cpu", "Container size", (v) => CONTAINER_SIZE_AWS.from(v)),
    },
    gcp: {
      type: "google_cloud_run_v2_service",
      matches: ["google_cloud_run_service", "google_cloud_run_v2_job"],
      moduleSource: GCP_MODULES.cloudRun,
      emit: (c) => GCP.containers.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) => {
        const limits = childBlock(b, "template", "containers", "resources");
        return readOne(limits ?? b, "limits", "Container size", (v) => runSizeFrom(/cpu\s*=\s*"([^"]+)"/.exec(v)?.[1]));
      },
      settings: { attribute: "", append: appendRunEnv },
      hostname: (ref) => `trimprefix(${refAddress(ref, "uri")}, "https://")`,
    },
  },

  {
    kind: "functions",
    category: "compute",
    label: "Functions",
    role: "serving",
    fronted: false,
    keywords: ["function", "functions", "serverless", "lambda", "event handler"],
    fields: [RUNTIME_FIELD],
    azure: {
      type: "azurerm_linux_function_app",
      matches: ["azurerm_function_app"],
      moduleSource: MODULE_VERSIONS["azure/web-site"].source,
      matchBlock: (b) => b.type !== "module" || stringValue(attr(b, "kind")) === "functionapp",
      // A function app needs a storage account for its own content and state. It
      // reaches it as itself — system-assigned identity, role assignment, shared
      // keys disabled — so no account key is ever written into the plan or state.
      //
      // Flex Consumption (FC1), not the classic Y1 plan: it bills per execution
      // the same way, and it is the consumption plan that can join a virtual
      // network. Its code is deployed to a blob container it reads as itself.
      emit: (c) => {
        const stack = azFunctionStack(c.attr("Runtime"));
        return {
          blocks: [
            moduleBlock("azure/storage-account", `${c.name}_storage`, [
              { key: "name", value: storageName(c.slug) },
              ...AZ_PARENT,
              { key: "account_sku_name", value: quote("Standard_LRS") },
              ...AZ_STORAGE_HARDENING,
              ...AZ_STORAGE_REACHABLE,
              {
                key: "containers",
                value: mapExpression([
                  { key: "deployments", value: mapExpression([{ key: "name", value: quote("deployments") }]) },
                ]),
              },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
            moduleBlock("azure/service-plan", `${c.name}_plan`, [
              { key: "name", value: cloudName("aspfn", c.slug) },
              ...AZ_PARENT,
              { key: "os_type", value: quote("Linux") },
              { key: "sku_name", value: quote("FC1") },
              { key: "worker_count", value: "1" },
              // Zone-redundant Flex Consumption is offered in a few regions only.
              { key: "zone_balancing_enabled", value: "false" },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
            moduleBlock("azure/web-site", c.name, [
              { key: "name", value: cloudName("fn", c.slug) },
              ...AZ_PARENT,
              { key: "kind", value: quote("functionapp") },
              { key: "os_type", value: quote("Linux") },
              { key: "service_plan_resource_id", value: `module.${c.name}_plan.resource_id` },
              { key: "storage_account_name", value: `module.${c.name}_storage.name` },
              { key: "storage_uses_managed_identity", value: "true" },
              { key: "function_app_uses_fc1", value: "true" },
              { key: "fc1_runtime_name", value: quote(stack.family) },
              { key: "fc1_runtime_version", value: quote(stack.value) },
              { key: "storage_container_type", value: quote("blobContainer") },
              {
                key: "storage_container_endpoint",
                value: `"https://\${module.${c.name}_storage.fqdn["blob"]}/deployments"`,
              },
              { key: "storage_authentication_type", value: quote("SystemAssignedIdentity") },
              { key: "https_only", value: "true" },
              { key: "public_network_access_enabled", value: "true" },
              c.private
                ? { key: "virtual_network_subnet_id", value: c.private.subnet(c.slug, "Microsoft.App/environments") }
                : null,
              AZ_IDENTITY,
              { key: "site_config", value: mapExpression(AZ_SITE_CONFIG_ENTRIES) },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
            // A separate resource rather than the storage module's own
            // `role_assignments` input: the grant depends on the app and the app
            // depends on the account, and keeping them apart keeps that a line
            // rather than a loop.
            block("resource", ["azurerm_role_assignment", `${c.name}_storage`], [
              { key: "scope", value: `module.${c.name}_storage.resource_id` },
              { key: "role_definition_name", value: quote("Storage Blob Data Owner") },
              { key: "principal_id", value: `module.${c.name}.identity_principal_id` },
            ]),
          ],
          referent: 2,
          consumer: 2,
          variables: [NAME_PREFIX],
          outputs: [{ name: `${c.name}_hostname`, value: `module.${c.name}.resource_uri` }],
        };
      },
      read: (b) => {
        // A Flex Consumption app names its runtime outright.
        const fc1 = Object.entries(AZ_FUNCTION_STACK).find(
          ([, entry]) =>
            stringValue(attr(b, "fc1_runtime_name")) === entry.family &&
            stringValue(attr(b, "fc1_runtime_version")) === entry.value,
        );
        if (fc1) return { Runtime: fc1[0] };
        // The module takes `site_config` as an object; a raw azurerm_linux_function_app
        // writes it as nested blocks. Both say the same thing about the runtime.
        const fromMap = mapEntries(
          mapEntries(attr(b, "site_config")).find((e) => e.key === "application_stack")?.value,
        );
        const fromBlocks = b.blocks
          .find((x) => x.type === "site_config")
          ?.blocks.find((x) => x.type === "application_stack");
        for (const [label, entry] of Object.entries(AZ_FUNCTION_STACK)) {
          const family = fromMap.find((e) => e.key === entry.family)?.value;
          const nested = mapEntries(family).find((e) => e.key === entry.key)?.value;
          if (stringValue(nested) === entry.value) return { Runtime: label };
          if (fromBlocks && stringValue(attr(fromBlocks, entry.key)) === entry.value) {
            return { Runtime: label };
          }
        }
        return {};
      },
      settings: { blockIndex: 2, attribute: "app_settings" },
      hostname: (ref) => `module.${ref.name}.resource_uri`,
    },
    aws: {
      type: "aws_lambda_function",
      moduleSource: MODULE_VERSIONS["aws/lambda"].source,
      // The module owns what a bare aws_lambda_function leaves to the reader: the
      // execution role, the log group, packaging from `source_path`, and a function
      // URL so the thing can actually be called.
      emit: (c) => ({
        blocks: [
          moduleBlock("aws/lambda", c.name, [
            { key: "function_name", value: cloudName("fn", c.slug) },
            { key: "handler", value: quote(lambdaRuntime(c.attr("Runtime")).handler) },
            { key: "runtime", value: quote(lambdaRuntime(c.attr("Runtime")).runtime) },
            { key: "source_path", value: quoteTemplate`\${path.module}/src/${c.slug}` },
            { key: "create_lambda_function_url", value: "true" },
            { key: "cloudwatch_logs_retention_in_days", value: "30" },
            { key: "tracing_mode", value: quote("Active") },
            { key: "attach_tracing_policy", value: "true" },
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_url`, value: `module.${c.name}.lambda_function_url` }],
        files: [
          {
            name: `src/${c.slug}/${lambdaRuntime(c.attr("Runtime")).file}`,
            content: lambdaRuntime(c.attr("Runtime")).stub,
          },
        ],
      }),
      read: (b) => {
        const runtime = stringValue(attr(b, "runtime"));
        const label = Object.entries(LAMBDA_RUNTIME).find(([, v]) => v.runtime === runtime)?.[0];
        return label ? { Runtime: label } : {};
      },
      settings: { attribute: "environment_variables" },
      // A function URL is `https://<id>.lambda-url.<region>.on.aws/`; a CDN origin wants
      // the bare host.
      hostname: (ref) => `trimsuffix(trimprefix(module.${ref.name}.lambda_function_url, "https://"), "/")`,
    },
    gcp: {
      type: "google_cloudfunctions2_function",
      matches: ["google_cloudfunctions_function"],
      emit: (c) => GCP.functions.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) => readOne(childBlock(b, "build_config") ?? b, "runtime", "Runtime", (v) => functionRuntimeFrom(v)),
      settings: { nestedBlock: "service_config", attribute: "environment_variables" },
      hostname: (ref) => `trimprefix(${refAddress(ref)}.service_config[0].uri, "https://")`,
    },
  },

  {
    kind: "static-site",
    category: "compute",
    label: "Static Site",
    role: "serving",
    keywords: ["static site", "static website", "spa", "single page", "jamstack", "gatsby", "static"],
    fields: [],
    azure: {
      type: "azurerm_static_web_app",
      moduleSource: MODULE_VERSIONS["azure/static-site"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/static-site", c.name, [
            { key: "name", value: cloudName("swa", c.slug) },
            ...AZ_GROUP,
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_hostname`, value: `module.${c.name}.resource_uri` }],
      }),
      hostname: (ref) => `module.${ref.name}.resource_uri`,
    },
    aws: {
      type: "aws_s3_bucket_website_configuration",
      moduleSource: MODULE_VERSIONS["aws/s3-bucket"].source,
      matchBlock: (b) => attr(b, "website") !== undefined,
      emit: (c) => {
        const logs = s3AccessLogs(c);
        return {
          blocks: [
            moduleBlock("aws/s3-bucket", c.name, [
              { key: "bucket", value: cloudName("site", c.slug) },
              { key: "control_object_ownership", value: "true" },
              { key: "object_ownership", value: quote("BucketOwnerPreferred") },
              ...S3_PUBLIC_ACCESS_BLOCK,
              { key: "versioning", value: mapExpression([{ key: "enabled", value: "true" }]) },
              // S3-managed keys: what the CDN in front of a site reads through.
              // CloudFront can decrypt under a customer-managed key whose policy
              // names it, but never under the AWS-managed `aws/s3` key.
              s3Encryption("AES256"),
              logs.logging,
              { key: "website", value: mapExpression([
                { key: "index_document", value: quote("index.html") },
                { key: "error_document", value: quote("error.html") },
              ]) },
            ]),
            logs.bucket,
          ],
          variables: [NAME_PREFIX],
          outputs: [{ name: `${c.name}_endpoint`, value: `module.${c.name}.s3_bucket_website_endpoint` }],
        };
      },
      hostname: (ref) => `module.${ref.name}.s3_bucket_bucket_regional_domain_name`,
    },
    gcp: {
      type: "google_storage_bucket",
      matchBlock: (b) => hasWebsite(b),
      moduleSource: GCP_MODULES.bucket,
      emit: (c) => GCP.staticSite.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "SITE_BUCKET", value: refAddress(ref, "name") }),
    },
  },

  {
    kind: "queue",
    category: "network",
    label: "Message Queue",
    role: "leaf",
    flag: { reason: "Delivery guarantees (ordering, dead-lettering) were not specified." },
    keywords: ["queue", "message", "messaging", "sqs", "service bus", "servicebus", "event", "pub/sub", "pubsub"],
    fields: [DELIVERY_FIELD],
    azure: {
      type: "azurerm_servicebus_queue",
      matches: ["azurerm_servicebus_namespace", "azurerm_storage_queue"],
      moduleSource: MODULE_VERSIONS["azure/servicebus"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/servicebus", c.name, [
            { key: "name", value: cloudName("sb", c.slug) },
            ...AZ_GROUP,
            { key: "sku", value: quote("Standard") },
            { key: "minimum_tls_version", value: quote("1.2") },
            // Infrastructure (double) encryption needs a customer-managed key and
            // a Premium namespace; the module turns it on by default.
            { key: "infrastructure_encryption_enabled", value: "false" },
            {
              key: "queues",
              value: mapExpression([
                {
                  key: "main",
                  value: mapExpression([
                    { key: "name", value: cloudName("q", c.slug) },
                    {
                      key: "requires_duplicate_detection",
                      value: DELIVERY.to(c.attr("Delivery"), "At least once"),
                    },
                    { key: "dead_lettering_on_message_expiration", value: "true" },
                  ]),
                },
              ]),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      read: (b) => {
        // In the module the queues are a map; in a raw azurerm_servicebus_queue
        // the same flag is an attribute of the block itself.
        const main = mapEntries(attr(b, "queues")).find((e) => e.key === "main")?.value;
        const nested = mapEntries(main).find((e) => e.key === "requires_duplicate_detection")?.value;
        const label = DELIVERY.from(nested);
        if (label) return { Delivery: label };
        return readOne(b, "requires_duplicate_detection", "Delivery", (v) => DELIVERY.from(v));
      },
      connection: (ref) => ({
        key: "QUEUE_NAME",
        value: `module.${ref.name}.resource_queues["main"].name`,
      }),
    },
    aws: {
      type: "aws_sqs_queue",
      moduleSource: MODULE_VERSIONS["aws/sqs"].source,
      emit: (c) => {
        const fifo = DELIVERY.to(c.attr("Delivery"), "At least once") === "true";
        return {
          blocks: [
            moduleBlock("aws/sqs", c.name, [
              // SQS requires a FIFO queue's name to end in .fifo.
              { key: "name", value: quoteTemplate`q-\${var.name_prefix}-${c.slug}${fifo ? ".fifo" : ""}` },
              { key: "fifo_queue", value: String(fifo) },
              { key: "create_dlq", value: "true" },
            ]),
          ],
          variables: [NAME_PREFIX],
        };
      },
      read: (b) => readOne(b, "fifo_queue", "Delivery", (v) => DELIVERY.from(v)),
      connection: (ref) => ({ key: "QUEUE_URL", value: refAddress(ref, "queue_url") }),
    },
    gcp: {
      type: "google_pubsub_topic",
      matches: ["google_pubsub_subscription"],
      moduleSource: GCP_MODULES.pubsub,
      emit: (c) => GCP.queue.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "PUBSUB_TOPIC", value: refAddress(ref, "id") }),
    },
  },

  {
    kind: "vnet",
    category: "network",
    label: "Virtual Network",
    role: "leaf",
    keywords: ["vnet", "vpc", "virtual network", "subnet", "network", "private network"],
    fields: [CIDR_FIELD],
    azure: {
      type: "azurerm_virtual_network",
      matches: ["azurerm_subnet"],
      moduleSource: MODULE_VERSIONS["azure/virtual-network"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/virtual-network", c.name, [
            { key: "name", value: cloudName("vnet", c.slug) },
            ...AZ_PARENT,
            { key: "address_space", value: `[${quote(c.attr("Address space"))}]` },
            {
              key: "subnets",
              value: mapExpression([
                {
                  key: "app",
                  value: mapExpression([
                    { key: "name", value: quote("app") },
                    { key: "address_prefix", value: quote(subnetOf(c.attr("Address space"))) },
                  ]),
                },
              ]),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
        outputs: [{ name: `${c.name}_id`, value: `module.${c.name}.resource_id` }],
      }),
      read: (b) => {
        const first = attr(b, "address_space")?.match(/"([^"]+)"/)?.[1];
        return first ? { "Address space": first } : {};
      },
      connection: (ref) => ({ key: "VNET_ID", value: refAddress(ref, "resource_id") }),
    },
    aws: {
      type: "aws_vpc",
      matches: ["aws_subnet"],
      moduleSource: MODULE_VERSIONS["aws/vpc"].source,
      emit: (c) => {
        const cidr = quote(c.attr("Address space"));
        return {
          blocks: [
            moduleBlock("aws/vpc", c.name, [
              { key: "name", value: cloudName("vpc", c.slug) },
              { key: "cidr", value: cidr },
              { key: "azs", value: `["\${var.region}a", "\${var.region}b"]` },
              { key: "private_subnets", value: `[cidrsubnet(${cidr}, 8, 1), cidrsubnet(${cidr}, 8, 2)]` },
              { key: "public_subnets", value: `[cidrsubnet(${cidr}, 8, 101), cidrsubnet(${cidr}, 8, 102)]` },
              { key: "enable_nat_gateway", value: "true" },
              { key: "single_nat_gateway", value: "true" },
              { key: "enable_flow_log", value: "true" },
              { key: "create_flow_log_cloudwatch_log_group", value: "true" },
              { key: "create_flow_log_cloudwatch_iam_role", value: "true" },
              { key: "flow_log_max_aggregation_interval", value: "60" },
            ]),
          ],
          variables: [NAME_PREFIX],
          outputs: [{ name: `${c.name}_id`, value: `module.${c.name}.vpc_id` }],
        };
      },
      read: (b) => readOne(b, "cidr", "Address space", (v) => v),
      connection: (ref) => ({ key: "VPC_ID", value: refAddress(ref, "vpc_id") }),
      network: (name) => ({
        vpcId: `module.${name}.vpc_id`,
        publicSubnets: `module.${name}.public_subnets`,
        privateSubnets: `module.${name}.private_subnets`,
      }),
    },
    gcp: {
      type: "google_compute_network",
      matches: [
        "google_compute_subnetwork",
        "google_compute_firewall",
        "google_compute_router",
        "google_compute_router_nat",
      ],
      moduleSource: GCP_MODULES.network,
      emit: (c) => GCP.network.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) =>
        // The subnet is cidrsubnet(<space>, 8, 1) of the space the model drew; the network holds neither.
        readOne(b, "ip_cidr_range", "Address space", (v) => /^cidrsubnet\(\s*"([^"]+)"/.exec(v)?.[1]),
      connection: (ref) => ({ key: "VPC_ID", value: refAddress(ref, "id") }),
      network: (name) => GCP.network.refs(name),
    },
  },

  {
    kind: "redis-cache",
    category: "storage",
    label: "Cache for Redis",
    role: "leaf",
    flag: { reason: "Cache SKU and size were not specified in the prompt." },
    keywords: ["redis", "cache", "memcached", "elasticache"],
    fields: [REDIS_FIELD],
    azure: {
      type: "azurerm_redis_cache",
      moduleSource: MODULE_VERSIONS["azure/redis"].source,
      emit: (c) => {
        const choice = c.attr("Cache SKU");
        const sku = REDIS_SKU_AZURE.to(choice, "Standard (C1)");
        return {
          blocks: [
            moduleBlock("azure/redis", c.name, [
              { key: "name", value: cloudName("redis", c.slug) },
              ...AZ_GROUP,
              { key: "sku_name", value: quote(sku) },
              { key: "capacity", value: REDIS_CAPACITY_AZURE[choice]?.capacity ?? "1" },
              { key: "minimum_tls_version", value: quote("1.2") },
              { key: "enable_non_ssl_port", value: "false" },
              // Availability zones are a Premium feature; the module asks for all
              // three by default, which a Basic or Standard cache cannot honour.
              { key: "zones", value: sku === "Premium" ? `["1", "2", "3"]` : "null" },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
          ],
          variables: [NAME_PREFIX],
        };
      },
      read: (b) => readOne(b, "sku_name", "Cache SKU", (v) => REDIS_SKU_AZURE.from(v)),
      connection: (ref) => ({ key: "REDIS_HOST", value: refAddress(ref, "resource.hostname") }),
    },
    aws: {
      type: "aws_elasticache_cluster",
      matches: ["aws_elasticache_replication_group"],
      moduleSource: MODULE_VERSIONS["aws/elasticache"].source,
      emit: (c) => {
        const { refs, variables } = netOrVars(c.net);
        return {
          blocks: [
            moduleBlock("aws/elasticache", c.name, [
              { key: "replication_group_id", value: cloudName("redis", c.slug) },
              { key: "engine", value: quote("redis") },
              { key: "engine_version", value: quote("7.1") },
              { key: "node_type", value: quote(REDIS_NODE_AWS.to(c.attr("Cache SKU"), "Standard (C1)")) },
              { key: "num_cache_clusters", value: "1" },
              { key: "at_rest_encryption_enabled", value: "true" },
              { key: "transit_encryption_enabled", value: "true" },
              { key: "vpc_id", value: refs.vpcId },
              { key: "subnet_ids", value: refs.privateSubnets },
            ]),
          ],
          variables: [NAME_PREFIX, ...variables],
        };
      },
      read: (b) => readOne(b, "node_type", "Cache SKU", (v) => REDIS_NODE_AWS.from(v)),
      connection: (ref) => ({
        key: "REDIS_HOST",
        value: refAddress(ref, "replication_group_primary_endpoint_address"),
      }),
    },
    gcp: {
      type: "google_redis_instance",
      matches: ["google_redis_cluster", "google_memcache_instance"],
      emit: (c) => GCP.redis.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) => {
        const tier = stringValue(attr(b, "tier"));
        const size = attr(b, "memory_size_gb")?.trim();
        const label = redisSkuFrom(tier, size);
        return label ? { "Cache SKU": label } : {};
      },
      connection: (ref) => ({ key: "REDIS_HOST", value: refAddress(ref, "host") }),
    },
  },

  {
    kind: "postgres",
    category: "storage",
    label: "PostgreSQL",
    role: "leaf",
    flag: { reason: "Compute tier is ambiguous — confirm sizing before generating." },
    keywords: ["postgres", "postgresql", "database", "db", "sql", "relational"],
    fields: [PG_FIELD, ENVIRONMENT_FIELD],
    azure: {
      type: "azurerm_postgresql_flexible_server",
      matches: ["azurerm_postgresql_server"],
      moduleSource: MODULE_VERSIONS["azure/postgres"].source,
      emit: (c) => {
        const production = isProduction(c);
        return {
          blocks: [
            moduleBlock("azure/postgres", c.name, [
              { key: "name", value: cloudName("pg", c.slug) },
              ...AZ_GROUP,
              {
                key: "server_version",
                value: quote(PG_VERSION.to(c.attr("PostgreSQL version"), "PostgreSQL 16")),
              },
              { key: "sku_name", value: quote("GP_Standard_D2s_v3") },
              { key: "storage_mb", value: "32768" },
              { key: "administrator_login", value: "var.db_username" },
              { key: "administrator_password", value: "var.db_password" },
              // Reachable through its private endpoint in the plan's network and
              // nowhere else. The module's own default firewall rule is
              // 0.0.0.0–255.255.255.255, so the rule set is stated empty.
              { key: "public_network_access_enabled", value: "false" },
              { key: "firewall_rules", value: "{}" },
              privateEndpoint(c, "privatelink.postgres.database.azure.com"),
              ...azDbPosture(production),
              // Who connected, when the server checkpointed, and a brake on
              // repeated failed logins — the server's own audit trail, off by default.
              {
                key: "server_configuration",
                value: mapExpression(
                  (
                    [
                      ["log_connections", "log_connections"],
                      ["log_checkpoints", "log_checkpoints"],
                      ["connection_throttle", "connection_throttle.enable"],
                    ] as const
                  ).map(([key, name]) => ({
                    key,
                    value: mapExpression([
                      { key: "name", value: quote(name) },
                      { key: "config", value: quote("on") },
                    ]),
                  })),
                ),
              },
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
          ],
          variables: [NAME_PREFIX, DB_USERNAME, DB_PASSWORD],
          outputs: [{ name: `${c.name}_fqdn`, value: `module.${c.name}.fqdn` }],
        };
      },
      read: (b) => ({
        // `server_version` is the module's name for it, `version` the raw
        // resource's — a pasted plan reads back the same as a generated one.
        ...readEither(b, ["server_version", "version"], "PostgreSQL version", (v) =>
          PG_VERSION.from(v),
        ),
        ...readOne(b, "backup_retention_days", "Environment", (v) =>
          v === "35" ? "Production" : "Dev / Test",
        ),
      }),
      connection: (ref) => ({ key: "DATABASE_HOST", value: refAddress(ref, "fqdn") }),
    },
    aws: {
      type: "aws_db_instance",
      moduleSource: MODULE_VERSIONS["aws/rds"].source,
      matchBlock: (b) => stringValue(attr(b, "engine")) === "postgres",
      emit: (c) => ({
        blocks: [
          moduleBlock("aws/rds", c.name, [
            { key: "identifier", value: cloudName("pg", c.slug) },
            { key: "engine", value: quote("postgres") },
            { key: "engine_version", value: quote(PG_VERSION.to(c.attr("PostgreSQL version"), "PostgreSQL 16")) },
            { key: "family", value: quote(`postgres${PG_VERSION.to(c.attr("PostgreSQL version"), "PostgreSQL 16")}`) },
            { key: "instance_class", value: quote("db.t3.medium") },
            { key: "allocated_storage", value: "20" },
            { key: "username", value: "var.db_username" },
            // The module keeps the master password in Secrets Manager; nothing in
            // the plan ever holds it.
            { key: "manage_master_user_password", value: "true" },
            { key: "create_db_option_group", value: "false" },
            // What the reviewer's Environment choice moves is retention, the
            // standby and the final snapshot; the hardening holds either way.
            ...AWS_DB_HARDENING,
            ...awsDbPosture(isProduction(c)),
            { key: "multi_az", value: isProduction(c) ? "true" : "false" },
            // Without a subnet group the instance lands in the account's default
            // VPC, not the one the model drew.
            c.net ? { key: "create_db_subnet_group", value: "true" } : null,
            c.net ? { key: "subnet_ids", value: c.net.privateSubnets } : null,
          ]),
        ],
        variables: [NAME_PREFIX, DB_USERNAME],
        outputs: [{ name: `${c.name}_endpoint`, value: `module.${c.name}.db_instance_endpoint` }],
      }),
      read: (b) => readOne(b, "engine_version", "PostgreSQL version", (v) => PG_VERSION.from(v)),
      connection: (ref) => ({ key: "DATABASE_HOST", value: refAddress(ref, "db_instance_address") }),
    },
    gcp: {
      type: "google_sql_database_instance",
      matchBlock: (b) => (stringValue(attr(b, "database_version")) ?? "").startsWith("POSTGRES_"),
      moduleSource: GCP_MODULES.postgres,
      matches: ["google_sql_database", "google_sql_user"],
      emit: (c) => GCP.postgres.emit({ ...c, gcp: gcpPlan(c) }),
      read: (b) => readOne(b, "database_version", "PostgreSQL version", (v) => PG_VERSION.from(v.replace(/^POSTGRES_/, ""))),
      connection: (ref) => ({ key: "DATABASE_HOST", value: refAddress(ref, "private_ip_address") }),
    },
  },

  {
    kind: "mysql",
    category: "storage",
    label: "MySQL",
    role: "leaf",
    keywords: ["mysql", "mariadb"],
    fields: [MYSQL_FIELD, ENVIRONMENT_FIELD],
    azure: {
      type: "azurerm_mysql_flexible_server",
      moduleSource: MODULE_VERSIONS["azure/mysql"].source,
      emit: (c) => {
        const production = isProduction(c);
        return {
          blocks: [
            moduleBlock("azure/mysql", c.name, [
              { key: "name", value: cloudName("mysql", c.slug) },
              ...AZ_GROUP,
              {
                key: "mysql_version",
                value: quote(MYSQL_VERSION_AZURE.to(c.attr("MySQL version"), "MySQL 8.4")),
              },
              { key: "sku_name", value: quote("GP_Standard_D2ds_v4") },
              { key: "administrator_login", value: "var.db_username" },
              { key: "administrator_password", value: "var.db_password" },
              // Reachable through its private endpoint in the plan's network and
              // nowhere else.
              { key: "public_network_access", value: quote("Disabled") },
              privateEndpoint(c, "privatelink.mysql.database.azure.com", "mysqlServer"),
              ...azDbPosture(production),
              AZ_TELEMETRY,
              AZ_TAGS,
            ]),
          ],
          variables: [NAME_PREFIX, DB_USERNAME, DB_PASSWORD],
        };
      },
      read: (b) => ({
        ...readEither(b, ["mysql_version", "version"], "MySQL version", (v) =>
          MYSQL_VERSION_AZURE.from(v),
        ),
        ...readOne(b, "backup_retention_days", "Environment", (v) =>
          v === "35" ? "Production" : "Dev / Test",
        ),
      }),
      // The module exposes the server's name but not its address. A Flexible
      // Server's FQDN is documented as <name>.mysql.database.azure.com, so this is
      // derived rather than guessed — and derived beats dropping the wire.
      connection: (ref) => ({
        key: "MYSQL_HOST",
        value: `"\${${refAddress(ref, "resource_name")}}.mysql.database.azure.com"`,
      }),
    },
    aws: {
      type: "aws_db_instance",
      moduleSource: MODULE_VERSIONS["aws/rds"].source,
      matchBlock: (b) => stringValue(attr(b, "engine")) === "mysql",
      emit: (c) => {
        const version = MYSQL_VERSION_AWS.to(c.attr("MySQL version"), "MySQL 8.4");
        return {
          blocks: [
            moduleBlock("aws/rds", c.name, [
              { key: "identifier", value: cloudName("mysql", c.slug) },
              { key: "engine", value: quote("mysql") },
              { key: "engine_version", value: quote(version) },
              { key: "family", value: quote(`mysql${version}`) },
              { key: "major_engine_version", value: quote(version) },
              { key: "instance_class", value: quote("db.t3.medium") },
              { key: "allocated_storage", value: "20" },
              { key: "username", value: "var.db_username" },
              { key: "manage_master_user_password", value: "true" },
              ...AWS_DB_HARDENING,
              ...awsDbPosture(isProduction(c)),
              { key: "multi_az", value: isProduction(c) ? "true" : "false" },
              c.net ? { key: "create_db_subnet_group", value: "true" } : null,
              c.net ? { key: "subnet_ids", value: c.net.privateSubnets } : null,
            ]),
          ],
          variables: [NAME_PREFIX, DB_USERNAME],
        };
      },
      read: (b) => readOne(b, "engine_version", "MySQL version", (v) => MYSQL_VERSION_AWS.from(v)),
      connection: (ref) => ({ key: "MYSQL_HOST", value: refAddress(ref, "db_instance_address") }),
    },
    gcp: {
      type: "google_sql_database_instance",
      matchBlock: (b) => (stringValue(attr(b, "database_version")) ?? "").startsWith("MYSQL_"),
      moduleSource: GCP_MODULES.mysql,
      emit: (c) => GCP.mysql.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "MYSQL_HOST", value: refAddress(ref, "private_ip_address") }),
      read: (b) =>
        readOne(b, "database_version", "MySQL version", (v) => MYSQL_VERSION_AWS.from(v.replace(/^MYSQL_/, "").replace("_", "."))),
    },
  },

  {
    kind: "nosql",
    category: "storage",
    label: "NoSQL Store",
    role: "leaf",
    keywords: ["nosql", "cosmos", "cosmosdb", "dynamo", "dynamodb", "document db", "mongo"],
    fields: [ENVIRONMENT_FIELD],
    azure: {
      type: "azurerm_cosmosdb_account",
      moduleSource: MODULE_VERSIONS["azure/cosmos"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/cosmos", c.name, [
            { key: "name", value: cloudName("cosmos", c.slug) },
            ...AZ_GROUP,
            {
              key: "consistency_policy",
              value: mapExpression([{ key: "consistency_level", value: quote("Session") }]),
            },
            { key: "minimal_tls_version", value: quote("Tls12") },
            // Reachable, but only by a caller Entra ID knows: the module disables
            // key-based access by default and this plan keeps it that way.
            { key: "public_network_access_enabled", value: "true" },
            { key: "local_authentication_disabled", value: "true" },
            { key: "automatic_failover_enabled", value: isProduction(c) ? "true" : "false" },
            {
              key: "backup",
              value: mapExpression([
                { key: "type", value: quote(isProduction(c) ? "Continuous" : "Periodic") },
              ]),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      connection: (ref) => ({ key: "COSMOS_ENDPOINT", value: refAddress(ref, "endpoint") }),
    },
    aws: {
      type: "aws_dynamodb_table",
      moduleSource: MODULE_VERSIONS["aws/dynamodb-table"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("aws/dynamodb-table", c.name, [
            { key: "name", value: cloudName("ddb", c.slug) },
            { key: "billing_mode", value: quote("PAY_PER_REQUEST") },
            { key: "hash_key", value: quote("id") },
            { key: "attributes", value: `[\n  { name = "id", type = "S" }\n]` },
            { key: "point_in_time_recovery_enabled", value: "true" },
            { key: "server_side_encryption_enabled", value: "true" },
            { key: "deletion_protection_enabled", value: isProduction(c) ? "true" : "false" },
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      connection: (ref) => ({ key: "DYNAMODB_TABLE", value: refAddress(ref, "dynamodb_table_id") }),
    },
    gcp: {
      type: "google_firestore_database",
      matches: ["google_bigtable_instance", "google_bigtable_table"],
      emit: (c) => GCP.nosql.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "FIRESTORE_DATABASE", value: refAddress(ref, "name") }),
    },
  },

  {
    kind: "object-storage",
    category: "storage",
    label: "Object Storage",
    role: "leaf",
    keywords: ["blob", "bucket", "object storage", "s3", "files", "uploads", "documents"],
    fields: [{ key: "Redundancy", options: REDUNDANCY.labels, fallback: "Local (LRS)" }],
    azure: {
      type: "azurerm_storage_account",
      moduleSource: MODULE_VERSIONS["azure/storage-account"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/storage-account", c.name, [
            { key: "name", value: storageName(c.slug) },
            ...AZ_PARENT,
            {
              key: "account_sku_name",
              value: quote(`Standard_${REDUNDANCY.to(c.attr("Redundancy"), "Local (LRS)")}`),
            },
            ...AZ_STORAGE_HARDENING,
            ...AZ_STORAGE_REACHABLE,
            {
              key: "blob_properties",
              value: mapExpression([{ key: "versioning_enabled", value: "true" }]),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      read: (b) => {
        // The module takes a whole SKU name; the raw resource splits it in two.
        const sku = stringValue(attr(b, "account_sku_name"))?.replace(/^Standard_/, "");
        const label = REDUNDANCY.from(sku);
        if (label) return { Redundancy: label };
        return readOne(b, "account_replication_type", "Redundancy", (v) => REDUNDANCY.from(v));
      },
      connection: (ref) => ({
        key: "STORAGE_ENDPOINT",
        value: `"https://\${${refAddress(ref, "fqdn")}["blob"]}/"`,
      }),
    },
    aws: {
      type: "aws_s3_bucket",
      moduleSource: MODULE_VERSIONS["aws/s3-bucket"].source,
      matchBlock: (b) => attr(b, "website") === undefined,
      emit: (c) => {
        const logs = s3AccessLogs(c);
        return {
          blocks: [
            moduleBlock("aws/s3-bucket", c.name, [
              { key: "bucket", value: cloudName("data", c.slug) },
              { key: "control_object_ownership", value: "true" },
              { key: "object_ownership", value: quote("BucketOwnerEnforced") },
              ...S3_PUBLIC_ACCESS_BLOCK,
              { key: "versioning", value: mapExpression([{ key: "enabled", value: "true" }]) },
              // SSE-KMS under the AWS-managed key; an edge to the plan's secret
              // store moves it onto that store's own key (see terraform.ts).
              s3Encryption("aws:kms"),
              logs.logging,
            ]),
            logs.bucket,
          ],
          variables: [NAME_PREFIX],
        };
      },
      connection: (ref) => ({ key: "STORAGE_BUCKET", value: refAddress(ref, "s3_bucket_id") }),
    },
    gcp: {
      type: "google_storage_bucket",
      matchBlock: (b) => !hasWebsite(b),
      moduleSource: GCP_MODULES.bucket,
      emit: (c) => GCP.objectStorage.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "STORAGE_BUCKET", value: refAddress(ref, "name") }),
    },
  },

  {
    kind: "entra-id",
    category: "identity",
    label: "Managed Identity",
    role: "leaf",
    keywords: ["entra", "identity", "sso", "oauth", "auth", "login", "iam", "role"],
    fields: [],
    azure: {
      type: "azurerm_user_assigned_identity",
      moduleSource: MODULE_VERSIONS["azure/user-assigned-identity"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/user-assigned-identity", c.name, [
            { key: "name", value: cloudName("id", c.slug) },
            ...AZ_GROUP,
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      connection: (ref) => ({ key: "IDENTITY_CLIENT_ID", value: refAddress(ref, "client_id") }),
    },
    aws: {
      type: "aws_iam_role",
      emit: (c) => ({
        blocks: [
          block("resource", ["aws_iam_role", c.name], [
            { key: "name", value: cloudName("role", c.slug) },
            {
              key: "assume_role_policy",
              value: `jsonencode({\n  Version = "2012-10-17"\n  Statement = [{\n    Action    = "sts:AssumeRole"\n    Effect    = "Allow"\n    Principal = { Service = "ec2.amazonaws.com" }\n  }]\n})`,
            },
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      connection: (ref) => ({ key: "ROLE_ARN", value: refAddress(ref, "arn") }),
    },
    gcp: {
      type: "google_service_account",
      moduleSource: GCP_MODULES.serviceAccounts,
      emit: (c) => GCP.identity.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "SERVICE_ACCOUNT", value: refAddress(ref, "email") }),
    },
  },

  {
    kind: "key-vault",
    category: "identity",
    label: "Secret Store",
    role: "leaf",
    keywords: ["vault", "secret", "secrets", "kms", "key vault", "certificate"],
    fields: [],
    azure: {
      type: "azurerm_key_vault",
      moduleSource: MODULE_VERSIONS["azure/key-vault"].source,
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/key-vault", c.name, [
            { key: "name", value: cloudName("kv", c.slug) },
            ...AZ_GROUP,
            { key: "tenant_id", value: "var.tenant_id" },
            { key: "sku_name", value: quote("standard") },
            // Purge protection is the one destroy-blocking setting on by default
            // everywhere: a vault deleted without it takes its secrets with it.
            { key: "purge_protection_enabled", value: "true" },
            { key: "soft_delete_retention_days", value: "90" },
            // Reachable through its private endpoint in the plan's network and
            // nowhere else; the ACL denies by default too, trusted Azure services
            // excepted, so reopening public access would not reopen the vault.
            { key: "public_network_access_enabled", value: "false" },
            privateEndpoint(c, "privatelink.vaultcore.azure.net"),
            {
              key: "network_acls",
              value: mapExpression([
                { key: "bypass", value: quote("AzureServices") },
                { key: "default_action", value: quote("Deny") },
              ]),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        variables: [NAME_PREFIX, TENANT_ID],
      }),
      connection: (ref) => ({ key: "KEY_VAULT_URI", value: refAddress(ref, "uri") }),
    },
    aws: {
      type: "aws_secretsmanager_secret",
      matches: ["aws_kms_key"],
      emit: (c) => ({
        blocks: [
          block("resource", ["aws_secretsmanager_secret", c.name], [
            { key: "name", value: cloudName("secret", c.slug) },
            { key: "kms_key_id", value: `aws_kms_key.${c.name}.arn` },
          ]),
          // The secret's own key rather than the account-wide `aws/secretsmanager`
          // one: who may decrypt it is then a key policy a reviewer can read, and
          // the key rotates yearly. The policy is AWS's default — the account
          // administers the key, and IAM decides who uses it.
          block("resource", ["aws_kms_key", c.name], [
            { key: "description", value: quote(`Encrypts the ${c.slug} secret`) },
            { key: "enable_key_rotation", value: "true" },
            {
              key: "policy",
              value: `jsonencode({\n  Version = "2012-10-17"\n  Statement = [{\n    Sid       = "AccountAdministersKey"\n    Effect    = "Allow"\n    Principal = { AWS = "arn:aws:iam::\${data.aws_caller_identity.${c.name}.account_id}:root" }\n    Action    = "kms:*"\n    Resource  = "*"\n  }]\n})`,
            },
          ]),
          block("data", ["aws_caller_identity", c.name], []),
        ],
        variables: [NAME_PREFIX],
      }),
      connection: (ref) => ({ key: "SECRET_ARN", value: refAddress(ref, "arn") }),
    },
    gcp: {
      type: "google_secret_manager_secret",
      matches: ["google_kms_key_ring", "google_kms_crypto_key", "google_project_service_identity"],
      moduleSource: GCP_MODULES.kms,
      emit: (c) => GCP.keyVault.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "SECRET_ID", value: refAddress(ref, "id") }),
    },
  },

  {
    kind: "monitoring",
    category: "observability",
    label: "Monitoring",
    role: "leaf",
    keywords: ["monitoring", "observability", "logs", "logging", "metrics", "telemetry", "app insights", "cloudwatch", "alerting"],
    fields: [RETENTION_FIELD],
    azure: {
      type: "azurerm_application_insights",
      matches: ["azurerm_log_analytics_workspace", "azurerm_monitor_diagnostic_setting"],
      moduleSource: MODULE_VERSIONS["azure/app-insights"].source,
      moduleMatches: [MODULE_VERSIONS["azure/log-analytics"].source],
      emit: (c) => ({
        blocks: [
          moduleBlock("azure/log-analytics", `${c.name}_workspace`, [
            { key: "name", value: cloudName("log", c.slug) },
            ...AZ_GROUP,
            { key: "log_analytics_workspace_sku", value: quote("PerGB2018") },
            {
              key: "log_analytics_workspace_retention_in_days",
              value: RETENTION.to(c.attr("Log retention"), "30 days"),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
          moduleBlock("azure/app-insights", c.name, [
            { key: "name", value: cloudName("appi", c.slug) },
            ...AZ_GROUP,
            { key: "workspace_id", value: `module.${c.name}_workspace.resource_id` },
            { key: "application_type", value: quote("web") },
            {
              key: "retention_in_days",
              value: RETENTION.to(c.attr("Log retention"), "30 days"),
            },
            AZ_TELEMETRY,
            AZ_TAGS,
          ]),
        ],
        referent: 1,
        consumer: 1,
        variables: [NAME_PREFIX],
      }),
      read: (b) => readOne(b, "retention_in_days", "Log retention", (v) => RETENTION.from(v)),
      connection: (ref) => ({
        key: "APPLICATIONINSIGHTS_CONNECTION_STRING",
        value: refAddress(ref, "connection_string"),
      }),
    },
    aws: {
      type: "aws_cloudwatch_log_group",
      matches: ["aws_cloudwatch_metric_alarm"],
      moduleSource: `${MODULE_VERSIONS["aws/cloudwatch"].source}//modules/log-group`,
      emit: (c) => ({
        blocks: [
          block("module", [c.name], [
            { key: "source", value: quote(`${MODULE_VERSIONS["aws/cloudwatch"].source}//modules/log-group`) },
            { key: "version", value: quote(MODULE_VERSIONS["aws/cloudwatch"].version) },
            { key: "name", value: cloudName("log", c.slug) },
            { key: "retention_in_days", value: RETENTION.to(c.attr("Log retention"), "30 days") },
          ]),
        ],
        variables: [NAME_PREFIX],
      }),
      read: (b) => readOne(b, "retention_in_days", "Log retention", (v) => RETENTION.from(v)),
      connection: (ref) => ({ key: "LOG_GROUP", value: refAddress(ref, "cloudwatch_log_group_name") }),
    },
    gcp: {
      type: "google_monitoring_alert_policy",
      matches: ["google_monitoring_notification_channel", "google_logging_metric", "google_logging_project_bucket_config"],
      emit: (c) => GCP.monitoring.emit({ ...c, gcp: gcpPlan(c) }),
      connection: (ref) => ({ key: "LOG_BUCKET", value: refAddress(ref, "bucket_id") }),
      read: (b) => readOne(b, "retention_days", "Log retention", (v) => RETENTION.from(v)),
    },
  },
  // Kinds only Google Cloud has: built there, left out (and reported as not buildable) on the other two.
  {
    kind: "project",
    category: "identity",
    label: "Project",
    role: "leaf",
    keywords: [],
    fields: [],
    azure: null,
    aws: null,
    gcp: {
      type: "google_project",
      matches: ["google_project_iam_audit_config"],
      moduleSource: GCP_MODULES.project,
      emit: (c) => GCP.project.emit({ ...c, gcp: gcpPlan(c) }),
    },
  },

  {
    kind: "kubernetes",
    category: "compute",
    label: "Kubernetes Cluster",
    role: "serving",
    keywords: [],
    fields: [ENVIRONMENT_FIELD],
    azure: null,
    aws: null,
    gcp: {
      type: "google_container_cluster",
      matches: ["google_container_node_pool"],
      moduleSource: GCP_MODULES.gke,
      emit: (c) => GCP.kubernetes.emit({ ...c, gcp: gcpPlan(c) }),
    },
  },

  {
    kind: "virtual-machine",
    category: "compute",
    label: "Virtual Machine",
    role: "serving",
    keywords: [],
    fields: [],
    azure: null,
    aws: null,
    gcp: {
      type: "google_compute_instance",
      matches: [
        "google_compute_instance_template",
        "google_compute_instance_group",
        "google_compute_instance_group_manager",
        "google_compute_region_instance_group_manager",
      ],
      emit: (c) => GCP.virtualMachine.emit({ ...c, gcp: gcpPlan(c) }),
    },
  },

  {
    kind: "data-warehouse",
    category: "storage",
    label: "Data Warehouse",
    role: "leaf",
    keywords: [],
    fields: [ENVIRONMENT_FIELD],
    azure: null,
    aws: null,
    gcp: {
      type: "google_bigquery_dataset",
      matches: ["google_bigquery_table"],
      moduleSource: GCP_MODULES.bigquery,
      emit: (c) => GCP.dataWarehouse.emit({ ...c, gcp: gcpPlan(c) }),
    },
  },
];

/* ---------------------------------------------------------------- helpers -- */

function attr(b: HclBlock, key: string): string | undefined {
  return b.attributes.find((a) => a.key === key)?.value;
}

/** Read one HCL attribute back to an inspector value via `map`, dropping misses. */
function readOne(
  b: HclBlock,
  hclKey: string,
  fieldKey: string,
  map: (raw: string) => string | undefined,
): Record<string, string> {
  return readEither(b, [hclKey], fieldKey, map);
}

/**
 * The same fact under any of several names.
 *
 * A kind reads back from two different documents: the module call this emitter
 * writes, and the raw resource block a customer pastes in — which the kind still
 * claims through `type` and `matches`. Those spell the same attribute
 * differently (`server_version` against `version`), and the inspector has to
 * show the reviewer's choice either way.
 */
function readEither(
  b: HclBlock,
  hclKeys: readonly string[],
  fieldKey: string,
  map: (raw: string) => string | undefined,
): Record<string, string> {
  const raw = hclKeys.map((k) => attr(b, k)).find((v) => v !== undefined);
  if (raw === undefined) return {};
  const plain = stringValue(raw) ?? raw.trim();
  const mapped = map(plain);
  return mapped ? { [fieldKey]: mapped } : {};
}

/** Derive a /24 inside the given address space so the subnet is always inside it. */
function subnetOf(cidr: string): string {
  const match = /^(\d+)\.(\d+)\./.exec(cidr.trim());
  return match ? `${match[1]}.${match[2]}.1.0/24` : "10.0.1.0/24";
}

/* --------------------------------------------------------------- accessors -- */

export const KIND_BY_ID: ReadonlyMap<string, KindDefinition> = new Map(
  KIND_DEFINITIONS.map((k) => [k.kind, k]),
);

/** Kinds a translator may select. `internet` is the conceptual ingress the spine
 *  adds itself and `external` is what the parser emits for a block it could not
 *  translate, so neither is ever part of the vocabulary a model chooses from. A kind that nothing
 *  builds on any cloud is read only and is not offered either. */
export const MODEL_KIND_IDS: readonly string[] = KIND_DEFINITIONS.filter(
  (k) => k.role !== "conceptual" && k.role !== "external" && (k.azure !== null || k.aws !== null || k.gcp?.emit !== undefined),
).map((k) => k.kind);

export const KIND_LABELS: Record<string, string> = Object.fromEntries(
  KIND_DEFINITIONS.map((k) => [k.kind, k.label]),
);

export function kindDefinition(kind: string): KindDefinition | undefined {
  return KIND_BY_ID.get(kind);
}

/** What a kind emits on a cloud: null when it has no way to build there, though it may still be read (`gcp`). */
export function cloudSpec(kind: string, cloud: Cloud): CloudSpec | null {
  const def = KIND_BY_ID.get(kind);
  if (!def) return null;
  if (cloud === "gcp") return def.gcp?.emit ? (def.gcp as CloudSpec) : null;
  return (cloud === "azure" ? def.azure : def.aws) ?? null;
}

function specOf(def: KindDefinition, cloud: Cloud): ReadSpec | null {
  return (cloud === "azure" ? def.azure : cloud === "aws" ? def.aws : def.gcp) ?? null;
}

/** What a kind reads back from on a cloud: its emit spec, or, on Google Cloud, its read spec. */
export function readSpec(kind: string, cloud: Cloud): ReadSpec | null {
  const def = KIND_BY_ID.get(kind);
  return def ? specOf(def, cloud) : null;
}

/** The editable fields the inspector shows for a kind. */
export function fieldsForKind(kind: string): readonly KindField[] {
  return KIND_BY_ID.get(kind)?.fields ?? [];
}

/** Why a node's free-text attributes cannot be used, one message per bad value. */
export function attributeProblems(nodes: readonly ModelNode[], cloud?: Cloud): string[] {
  const problems: string[] = [];
  for (const node of nodes) {
    for (const field of fieldsForKind(node.kind)) {
      const value = node.attributes?.[field.key];
      const problem = value === undefined ? null : field.validate?.(value, cloud);
      if (problem) problems.push(`${node.label || node.id}: ${field.key} ${problem}`);
    }
  }
  return problems;
}

/** Ingress kinds, closest to the internet first. */
export const INGRESS_ORDER: readonly string[] = KIND_DEFINITIONS.filter(
  (k) => k.role === "ingress" || k.role === "conceptual",
)
  .slice()
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map((k) => k.kind);

export const SERVING_KINDS: readonly string[] = KIND_DEFINITIONS.filter(
  (k) => k.role === "serving",
).map((k) => k.kind);

/**
 * Reverse-map a Terraform resource type to a model kind. `block` disambiguates the
 * types two kinds share (`aws_db_instance` is postgres or mysql by its `engine`);
 * without one, the first kind that claims the type is the answer.
 */
export function resourceTypeToKind(
  type: string,
  cloud?: Cloud,
  parsed?: HclBlock,
): { kind: string; cloud: Cloud } | null {
  const clouds: Cloud[] = cloud ? [cloud] : ["azure", "aws", "gcp"];
  let fallback: { kind: string; cloud: Cloud } | null = null;
  // Two kinds can claim a type as a secondary (a load balancer's pieces are also a CDN's). Without a block to tell
  // them apart, the kind whose primary the type is answers before one that only lists it.
  let listed: { kind: string; cloud: Cloud } | null = null;
  for (const c of clouds) {
    for (const def of KIND_DEFINITIONS) {
      const spec = specOf(def, c);
      if (!spec) continue;
      const claims = spec.type === type || (spec.matches?.includes(type) ?? false);
      if (!claims) continue;
      if (spec.matchBlock && parsed) {
        if (spec.matchBlock(parsed)) return { kind: def.kind, cloud: c };
        continue;
      }
      if (spec.type === type || !spec.matchBlock) fallback ??= { kind: def.kind, cloud: c };
      else listed ??= { kind: def.kind, cloud: c };
    }
  }
  return fallback ?? listed;
}

/**
 * Reverse-map a `module` block to a kind by its registry source, the way
 * `resourceTypeToKind` maps a resource type. Two kinds can share a module (RDS is
 * postgres or mysql by `engine`; one S3 module is a site or a bucket by `website`),
 * so the block disambiguates exactly as it does for a shared resource type.
 */
export function moduleSourceToKind(
  source: string,
  parsed?: HclBlock,
): { kind: string; cloud: Cloud } | null {
  let fallback: { kind: string; cloud: Cloud } | null = null;
  for (const c of ["azure", "aws", "gcp"] as const) {
    for (const def of KIND_DEFINITIONS) {
      const spec = specOf(def, c);
      if (!spec?.moduleSource) continue;
      if (spec.moduleSource !== source && !spec.moduleMatches?.includes(source)) continue;
      if (spec.matchBlock) {
        if (parsed && spec.matchBlock(parsed)) return { kind: def.kind, cloud: c };
        continue;
      }
      fallback ??= { kind: def.kind, cloud: c };
    }
  }
  return fallback;
}

/**
 * Whether a module call is scaffolding rather than a component: the Azure resource group, the
 * network an Azure plan adds when the model draws none and its private DNS zones (`isAzureScaffold`),
 * or the bucket a bucket's access logs go to. Only exactly what the generator writes, used by a
 * component of the file, counts; a lookalike is drawn, the way `isScaffoldResource` does for Google Cloud.
 */
export function isScaffoldModule(b: HclBlock, all: readonly HclBlock[]): boolean {
  return isAzureScaffold(b, all, (user) => becomesNode(user, all)) || isS3LogBucket(b, all);
}

/**
 * Whether the reader draws a block as a node of its own (or inside one): a module call that is not the
 * log bucket of a bucket, or a resource of a type some kind reads that is not what the plan adds around a component.
 * A variable, output, local, data source or provider block, and a resource no kind reads, are not.
 */
function becomesNode(b: HclBlock, all: readonly HclBlock[]): boolean {
  if (b.type === "module") return !isS3LogBucket(b, all);
  if (b.type !== "resource" || b.labels.length !== 2) return false;
  return !isGcpScaffold(b, all) && resourceTypeToKind(b.labels[0] ?? "", undefined, b) !== null;
}

/** Whether the derived spine fronts this kind with an edge tier by default. */
/**
 * Whether a resource block is something a Google Cloud plan adds around a component (the
 * API switches, a log or source bucket, the private service connection) rather than a
 * component of its own, so reading the plan back does not draw it. Only exactly what the
 * generator writes, tied to the component that uses it, counts (`isGcpScaffold`); a lookalike is drawn.
 */
export function isScaffoldResource(b: HclBlock, all: readonly HclBlock[]): boolean {
  return isGcpScaffold(b, all);
}

/**
 * Whether a resource block is the dead-letter topic a Google Cloud plan adds for a queue, which reads back as
 * part of the queue rather than as a queue of its own. Only exactly what the generator writes, given up on by
 * the subscription of the topic it is named for, counts (`isGcpDeadLetterTopic`); a topic of the file's own is drawn.
 */
export function isDeadLetterTopic(b: HclBlock, all: readonly HclBlock[]): boolean {
  return isGcpDeadLetterTopic(b, all);
}

/**
 * Whether a resource block is a Pub/Sub subscription that is not the one a Google Cloud plan adds for its queue
 * (`isGcpQueueSubscription`): a push endpoint, a filter, a second consumer, a subscription on a topic of the file's own.
 * It is not part of a queue (the queue's own subscription says nothing about what else reads the topic), so `parse` draws it on its own, flagged.
 */
export function isForeignSubscription(b: HclBlock, all: readonly HclBlock[]): boolean {
  return b.type === "resource" && b.labels.length === 2 && b.labels[0] === "google_pubsub_subscription" && !isGcpQueueSubscription(b, all);
}

export function isFronted(kind: string): boolean {
  return KIND_BY_ID.get(kind)?.fronted !== false;
}

/** Provider source + version constraint for a cloud, from `provider-versions.ts`. */
export function providerFor(cloud: GeneratedCloud): { name: string; source: string; version: string } {
  return PROVIDER_VERSIONS[cloud];
}

/** What a Google Cloud plan grants and starts from, for the sandbox's check of a plan to be held against (tests/sandbox-gcp-validate.test.ts). */
export { GCP_IMAGES, GCP_LOG_DELIVERY_MEMBER, GCP_ROLES } from "./gcp-kinds.ts";
