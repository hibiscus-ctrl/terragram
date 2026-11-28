// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import {
  addMapEntry,
  attributeOf,
  block,
  type HclBlock,
  mapEntries,
  mapExpression,
  quote,
  quoteTemplate,
  renderDocument,
  stringValue,
} from "./hcl.ts";
import { compareText } from "./graph/normalize.ts";
import { GCP_BETA_REF, GCP_EDGE_PREFIX, GCP_LABELS, type GcpPlan, gcpBackend, privateServicesBlocks } from "./gcp-kinds.ts";
import { MODULE_VERSIONS } from "./module-versions.ts";
import {
  AWS_US_EAST_1,
  attributeProblems,
  cloudSpec,
  type CloudSpec,
  type CustomDomain,
  type EmitContext,
  type EmitRef,
  fieldsForKind,
  frontDoorOrigin,
  modelIsProduction,
  type NetworkRefs,
  PLAN_NETWORK,
  type PrivateNetwork,
  providerFor,
  refAddress,
  s3Encryption,
  type SettingsTarget,
  TAGS,
  type VariableSpec,
} from "./kinds.ts";
import { type Cloud, type InfraModel, type ModelNode, resourceNodes } from "./model.ts";
import { PROVIDER_VERSIONS } from "./provider-versions.ts";

/**
 * Model → Terraform. Every resource fact comes from the kind registry; what this
 * file owns is the document: identity, wiring and layout.
 *
 * Identity is per node, not per kind. Two Postgres nodes emit two non-colliding
 * blocks because the Terraform name is derived from the node id, which is also what
 * makes free-form canvas editing safe.
 *
 * Wiring is the part that makes the diagram honest. Every edge the reviewer can see
 * has to appear in the code, so each one becomes a real provider reference where one
 * exists — an app setting pointing at the database's FQDN, a CDN origin pointing at
 * the app's hostname — and an explicit `depends_on` where it does not. A diagram
 * whose edges vanished at emit time would be a drawing, not a model.
 */

export type TerraformTool = "terraform" | "opentofu";

export type TerraformFile = { name: string; content: string };
/** A registry module the plan calls, with the exact version it pins. */
type ModuleCall = { name: string; source: string; version: string };
export type TerraformOutput = {
  provider: string;
  providerVersion: string;
  region: string;
  regionLabel: string;
  tool: TerraformTool;
  /** The three plan files first, then anything a kind wrote beside them (a
   *  function's handler stub) — every file the bundle and the zip carry. */
  files: TerraformFile[];
  /** Every module call in the plan — what the receipt's SBOM records beside the provider. */
  modules: ModuleCall[];
  /** Any provider the plan declares beside the main one (a function's archive provider), for the same SBOM. */
  extraProviders: Array<{ name: string; version: string }>;
};

const CLOUD_CONFIG: Record<Cloud, { region: string; regionLabel: string; label: string }> = {
  azure: { region: "uksouth", regionLabel: "UK South", label: "Azure" },
  aws: { region: "eu-west-2", regionLabel: "London (eu-west-2)", label: "AWS" },
  gcp: { region: "europe-west2", regionLabel: "London (europe-west2)", label: "Google Cloud" },
};

const TOOL_LABEL: Record<TerraformTool, string> = {
  terraform: "Terraform",
  opentofu: "OpenTofu",
};

/* ------------------------------------------------------------- identifiers -- */

/** A Terraform block name: lowercase, underscore-separated, never leading-digit. */
function tfName(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return /^[0-9]/.test(slug) || slug === "" ? `r_${slug}` : slug;
}

/** A cloud resource-name fragment: lowercase, hyphen-separated. */
function tfSlug(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug === "" ? "node" : slug;
}

type Emitted = {
  node: ModelNode;
  spec: CloudSpec;
  name: string;
  context: EmitContext;
  blocks: HclBlock[];
  consumer: HclBlock;
  referent: EmitRef;
};

/** How a block is addressed from elsewhere: `module.x` or `type.x`. */
function referenceTo(referentBlock: HclBlock, fallback: EmitRef): EmitRef {
  if (referentBlock.type === "module") {
    return { type: "module", name: referentBlock.labels[0] ?? fallback.name };
  }
  return {
    type: referentBlock.labels[0] ?? fallback.type,
    name: referentBlock.labels[1] ?? fallback.name,
  };
}

/* ------------------------------------------------------------------ wiring -- */

/** Add `entry` to a consumer's settings map, creating the map (and its nested
 *  block) when this is the first dependency to land there. */
function addSetting(
  host: HclBlock,
  target: SettingsTarget,
  entry: { key: string; value: string },
): void {
  if (target.append) {
    target.append(host, entry);
    return;
  }
  let owner = host;
  if (target.nestedBlock) {
    const found = owner.blocks.find((b) => b.type === target.nestedBlock);
    if (found) {
      owner = found;
    } else {
      const created: HclBlock = { type: target.nestedBlock, labels: [], attributes: [], blocks: [] };
      owner.blocks.push(created);
      owner = created;
    }
  }
  addMapEntry(owner, target.attribute, entry);
}

/** Add an explicit dependency, the honest fallback when no attribute carries it. */
function addDependsOn(host: HclBlock, address: string): void {
  const existing = host.attributes.find((a) => a.key === "depends_on");
  const current = existing
    ? existing.value.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (current.includes(address)) return;
  current.push(address);
  const value = `[${current.join(", ")}]`;
  if (existing) existing.value = value;
  else host.attributes.push({ key: "depends_on", value });
}

/** What wiring learns about the plan as a whole while it runs. */
type WirePlan = {
  /** What the reviewer has to do outside Terraform, written into the plan's header. */
  notes: string[];
  /** node id -> the name its own certificate covers, once a zone has given it one. */
  domains: Map<string, string>;
};

/**
 * Wire one edge. Ingress tiers get their own shapes because "put the CDN in front of
 * the app" is a real provider relationship with real extra resources, not a setting.
 * Returns any blocks the wire had to add.
 */
function wireEdge(source: Emitted, target: Emitted, cloud: Cloud, plan: WirePlan): HclBlock[] {
  const hostname = target.spec.hostname?.(target.referent);
  const originName = `${source.name}_to_${target.name}`;
  // Azure resource names allow hyphens but not underscores; the Terraform block
  // name is the underscore form, the cloud name the hyphen form.
  const originCloudName = quote(originName.replace(/_/g, "-"));

  // A load balancer, or the CDN in front of an application, gets a backend for what it fronts. Whatever has
  // none to write (a database, a queue) is the dependency the generic wire below makes it.
  if (cloud === "gcp" && (source.node.kind === "front-door" || source.node.kind === "load-balancer")) {
    const edge = source.node.kind === "front-door";
    const backend = gcpBackend(
      {
        name: originName,
        slug: tfSlug(source.node.id),
        prefix: edge ? GCP_EDGE_PREFIX : "lb",
        cdn: edge,
        ...(edge ? { policy: `google_compute_security_policy.${source.name}.id` } : {}),
      },
      { kind: target.node.kind, name: target.name, domain: plan.domains.get(target.node.id) },
    );
    if (backend) {
      // The first backend is where the URL map sends what no rule names; a later one is reachable by rule only.
      if (!source.consumer.attributes.some((a) => a.key === "default_service")) {
        source.consumer.attributes.push({ key: "default_service", value: backend.service });
        source.consumer.blocks.push(...backend.routes);
      }
      if (backend.admit) {
        const admitted = target.consumer.attributes.find((a) => a.key === backend.admit?.attribute);
        if (admitted) admitted.value = backend.admit.value;
      }
      return backend.blocks;
    }
  }

  if (source.node.kind === "front-door" && hostname) {
    if (cloud === "azure") {
      // The profile module owns its origins and routes, so the edge adds map
      // entries to the call rather than resources beside it.
      frontDoorOrigin(source.consumer, originName.replace(/_/g, "-"), originCloudName, hostname);
      return [];
    }
    if (target.node.kind === "static-site") return siteOrigin(source, target, originName, hostname);
    // The origin protocol is what the target actually serves. A load balancer
    // serves HTTPS only on the name its certificate covers, so CloudFront asks
    // for that name; without one it, like an instance, serves plain HTTP.
    const domain = plan.domains.get(target.node.id);
    const https = target.node.kind === "load-balancer" ? domain !== undefined : target.node.kind !== "app-service";
    source.consumer.blocks.push(
      block("origin", [], [
        { key: "domain_name", value: domain ? quote(domain) : hostname },
        { key: "origin_id", value: quote(originName) },
      ], [
        block("custom_origin_config", [], [
          { key: "http_port", value: "80" },
          { key: "https_port", value: "443" },
          { key: "origin_protocol_policy", value: quote(https ? "https-only" : "http-only") },
          { key: "origin_ssl_protocols", value: `["TLSv1.2"]` },
        ]),
      ]),
    );
    return [];
  }

  // The ALB module's one target group is IP-typed, so the thing behind it registers
  // itself: an ECS service through its own `load_balancer` block (the service is
  // not a target — its tasks are, and ECS registers them), an instance by private
  // IP. Either way the target's security group admits the balancer and nothing
  // else, and the balancer's own egress reaches that target and nothing else.
  // Anything else behind an ALB stays an explicit dependency.
  if (source.node.kind === "load-balancer" && cloud === "aws") {
    const targetGroupArn = `${refAddress(source.referent, "target_groups")}["app"].arn`;
    const port = (securityGroup: string) =>
      mapExpression([
        { key: "from_port", value: "80" },
        { key: "to_port", value: "80" },
        { key: "ip_protocol", value: quote("tcp") },
        { key: "referenced_security_group_id", value: securityGroup },
      ]);
    const fromBalancer = port(refAddress(source.referent, "security_group_id"));
    if (target.node.kind === "containers" || target.node.kind === "app-service") {
      addSetting(source.consumer, { attribute: "security_group_egress_rules" }, {
        key: target.name,
        value: port(refAddress(target.referent, "security_group_id")),
      });
    }
    if (target.node.kind === "containers") {
      target.consumer.attributes.push({
        key: "load_balancer",
        value: mapExpression([
          {
            key: "service",
            value: mapExpression([
              { key: "target_group_arn", value: targetGroupArn },
              { key: "container_name", value: quote("app") },
              { key: "container_port", value: "80" },
            ]),
          },
        ]),
      });
      addSetting(target.consumer, { attribute: "security_group_ingress_rules" }, { key: "alb", value: fromBalancer });
      return [];
    }
    if (target.node.kind === "app-service") {
      addSetting(target.consumer, { attribute: "security_group_ingress_rules" }, { key: "alb", value: fromBalancer });
      return [
        block("resource", ["aws_lb_target_group_attachment", originName], [
          { key: "target_group_arn", value: targetGroupArn },
          { key: "target_id", value: refAddress(target.referent, "private_ip") },
          { key: "port", value: "80" },
        ]),
      ];
    }
  }

  // A zone's record names a tier by its hostname, or on Google Cloud, where a balancer answers on an address, by that.
  const address = cloud === "gcp" ? target.spec.addressResource?.(target.referent) : undefined;
  if (source.node.kind === "dns" && (hostname || address)) {
    // The zone's name comes from the reviewer's attribute, which is the same
    // value the zone module was given.
    const zoneName = source.context.attr("Zone name");
    const domain: CustomDomain = {
      name: originName,
      record: "www",
      fqdn: `www.${zoneName}`,
      zoneName,
      zoneId:
        cloud === "azure"
          ? refAddress(source.referent, "resource_id")
          : refAddress(source.referent, source.referent.type === "module" ? "id" : "zone_id"),
      zone: source.consumer,
    };
    // A record naming a tier that does not answer for that name is a dangling
    // hostname, so a tier that can serve it is given the name and its certificate.
    const served = target.spec.customDomain?.(target.consumer, domain, target.blocks) ?? [];
    if (target.spec.customDomain) {
      plan.domains.set(target.node.id, domain.fqdn);
      plan.notes.push(customDomainNote(domain, cloud, refAddress(source.referent), `${source.name}_name_servers`));
    }
    if (cloud === "gcp") {
      // A name for a tier that answers on an address gets an A record; one that answers on a name, a CNAME.
      return [
        block("resource", ["google_dns_record_set", originName], [
          { key: "managed_zone", value: refAddress(source.referent, "name") },
          { key: "name", value: `"${domain.record}.\${${refAddress(source.referent, "dns_name")}}"` },
          { key: "type", value: quote(address ? "A" : "CNAME") },
          { key: "ttl", value: "300" },
          { key: "rrdatas", value: address ? `[${address}]` : `["\${${hostname ?? ""}}."]` },
        ]),
        ...served,
      ];
    }
    if (cloud === "azure") {
      // The zone module owns its records. A tier that answers on an address
      // gets an alias A record that follows its public IP; a CNAME may only
      // name another name.
      const alias = target.spec.addressResource?.(target.referent);
      if (alias) {
        addMapEntry(source.consumer, "a_records", {
          key: domain.record,
          value: mapExpression([
            { key: "name", value: quote(domain.record) },
            { key: "resource_group_name", value: "module.resource_group.name" },
            { key: "zone_name", value: quote(zoneName) },
            { key: "ttl", value: "300" },
            { key: "target_resource_id", value: alias },
          ]),
        });
        return served;
      }
      addMapEntry(source.consumer, "cname_records", {
        key: domain.record,
        value: mapExpression([
          { key: "name", value: quote(domain.record) },
          { key: "resource_group_name", value: "module.resource_group.name" },
          { key: "zone_name", value: quote(zoneName) },
          { key: "ttl", value: "300" },
          { key: "record", value: hostname ?? "" },
        ]),
      });
      return served;
    }
    return [
      block("resource", ["aws_route53_record", originName], [
        { key: "zone_id", value: domain.zoneId },
        { key: "name", value: quote(domain.record) },
        { key: "type", value: quote("CNAME") },
        { key: "ttl", value: "300" },
        { key: "records", value: `[${hostname}]` },
      ]),
      ...served,
    ];
  }

  // A bucket wired to the plan's secret store is encrypted under that store's own
  // customer-managed key instead of the AWS-managed one.
  if (cloud === "aws" && source.node.kind === "object-storage" && target.node.kind === "key-vault") {
    const encryption = source.consumer.attributes.find((a) => a.key === "server_side_encryption_configuration");
    if (encryption) encryption.value = s3Encryption("aws:kms", `aws_kms_key.${target.name}.arn`).value;
    return [];
  }

  // A bucket wired to the plan's secret store is encrypted under that store's own customer-managed key,
  // which Cloud Storage's service agent is allowed to use. The bucket waits for that grant.
  if (cloud === "gcp" && source.node.kind === "object-storage" && target.node.kind === "key-vault") {
    const agent = `data.google_storage_project_service_account.${originName}.email_address`;
    const grant = `google_kms_crypto_key_iam_member.${originName}`;
    source.consumer.blocks.push(
      block("encryption", [], [{ key: "default_kms_key_name", value: `google_kms_crypto_key.${target.name}.id` }]),
    );
    addDependsOn(source.consumer, grant);
    return [
      block("data", ["google_storage_project_service_account", originName], []),
      block("resource", ["google_kms_crypto_key_iam_member", originName], [
        { key: "crypto_key_id", value: `google_kms_crypto_key.${target.name}.id` },
        { key: "role", value: quote("roles/cloudkms.cryptoKeyEncrypterDecrypter") },
        { key: "member", value: `"serviceAccount:\${${agent}}"` },
      ]),
    ];
  }

  const connection = target.spec.connection?.(target.referent);
  if (source.spec.settings && connection) {
    const host = source.blocks[source.spec.settings.blockIndex ?? 0] ?? source.consumer;
    addSetting(host, source.spec.settings, connection);
    return [];
  }

  addDependsOn(source.consumer, `${target.referent.type}.${target.referent.name}`);
  return [];
}

/** The address space of the network an Azure plan adds when the model draws none. */
const PLAN_ADDRESS_SPACE = "10.0.0.0/16";

type SubnetRequest = { delegation: string | undefined; outbound: boolean | undefined };

/**
 * The Azure plan's private network as the kinds see it while they emit: a subnet
 * or a zone exists because a kind asked for it, once however many ask.
 */
function privateNetwork(name: string): {
  api: PrivateNetwork;
  subnets: Map<string, SubnetRequest>;
  zones: Map<string, string>;
} {
  const subnets = new Map<string, SubnetRequest>();
  const zones = new Map<string, string>();
  return {
    subnets,
    zones,
    api: {
      subnet: (key, delegation, outbound) => {
        if (!subnets.has(key)) subnets.set(key, { delegation, outbound });
        return `module.${name}.subnets[${quote(key)}].resource_id`;
      },
      dnsZone: (zone) => {
        // privatelink.vaultcore.azure.net -> private_dns_vaultcore
        const tf = `private_dns_${zone.replace(/^privatelink\./, "").split(".")[0]?.replace(/[^a-z0-9]+/g, "_")}`;
        zones.set(zone, tf);
        return `module.${tf}.resource_id`;
      },
    },
  };
}

/** The network a plan adds for itself: one address space, and the subnets its
 *  kinds ask for, added once they have all asked. */
function planNetwork(): HclBlock {
  const pin = MODULE_VERSIONS["azure/virtual-network"];
  return block("module", [PLAN_NETWORK], [
    { key: "source", value: quote(pin.source) },
    { key: "version", value: quote(pin.version) },
    { key: "name", value: quoteTemplate`vnet-\${var.name_prefix}` },
    { key: "parent_id", value: "module.resource_group.resource_id" },
    { key: "location", value: "module.resource_group.location" },
    { key: "address_space", value: `[${quote(PLAN_ADDRESS_SPACE)}]` },
    { key: "enable_telemetry", value: "false" },
    { key: "tags", value: "local.tags" },
  ]);
}

/** What sits behind each private DNS zone, as the note names it. */
const PRIVATE_SERVICES: Record<string, string> = {
  "privatelink.vaultcore.azure.net": "Key Vault",
  "privatelink.postgres.database.azure.com": "PostgreSQL",
  "privatelink.mysql.database.azure.com": "MySQL",
};

/** What private endpoints ask of whoever administers what sits behind them. */
function privateNetworkNote(network: string, zones: Iterable<string>): string {
  const names = [...zones].map((zone) => PRIVATE_SERVICES[zone] ?? zone);
  const services = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  return [
    `Private network: ${services} accept connections only through private endpoints in`,
    `${network}, and the apps reach them through VNet integration. Anything that administers`,
    "them from elsewhere (a pipeline writing secrets, psql from a workstation) needs a route",
    "into that network first: a VPN, a bastion host or a runner inside it.",
  ].join("\n");
}

/**
 * CloudFront in front of a site bucket. The bucket stays private: CloudFront signs
 * its requests through an origin access control, and the bucket's policy lets
 * that one distribution read objects and nothing else read anything. A bucket-
 * backed site is served from its index document; without a root object, a request
 * for "/" asks the bucket for an empty key.
 */
function siteOrigin(source: Emitted, target: Emitted, originName: string, hostname: string): HclBlock[] {
  const access = block("resource", ["aws_cloudfront_origin_access_control", originName], [
    { key: "name", value: quoteTemplate`oac-\${var.name_prefix}-${originName.replace(/_/g, "-")}` },
    { key: "origin_access_control_origin_type", value: quote("s3") },
    { key: "signing_behavior", value: quote("always") },
    { key: "signing_protocol", value: quote("sigv4") },
  ]);
  source.consumer.blocks.push(
    block("origin", [], [
      { key: "domain_name", value: hostname },
      { key: "origin_id", value: quote(originName) },
      { key: "origin_access_control_id", value: `aws_cloudfront_origin_access_control.${originName}.id` },
    ]),
  );
  if (!source.consumer.attributes.some((a) => a.key === "default_root_object")) {
    source.consumer.attributes.push({ key: "default_root_object", value: quote("index.html") });
  }
  // The bucket's name is a literal the plan already wrote; its ARN is derived
  // from it rather than read from the module, whose input this policy is.
  const bucket = stringValue(attributeOf(target.consumer, "bucket")) ?? "";
  target.consumer.attributes.push(
    { key: "attach_policy", value: "true" },
    {
      key: "policy",
      value: [
        "jsonencode({",
        '  Version = "2012-10-17"',
        "  Statement = [{",
        '    Sid       = "CloudFrontReadsTheSite"',
        '    Effect    = "Allow"',
        '    Principal = { Service = "cloudfront.amazonaws.com" }',
        '    Action    = "s3:GetObject"',
        `    Resource  = "arn:aws:s3:::${bucket}/*"`,
        `    Condition = { StringEquals = { "AWS:SourceArn" = ${refAddress(source.referent, "arn")} } }`,
        "  }]",
        "})",
      ].join("\n"),
    },
  );
  return [access];
}

/**
 * What a custom domain asks of the reviewer before `apply`. The certificate is
 * validated through the zone the plan creates, and nothing but the registrar can
 * send the world to that zone — so validation, and with it the HTTPS name, waits
 * on a delegation Terraform cannot make.
 */
function customDomainNote(domain: CustomDomain, cloud: Cloud, zoneAddress: string, nameServersOutput: string): string {
  const waits =
    cloud === "aws"
      ? "Until the zone is delegated, apply waits on the certificate's validation (aws_acm_certificate_validation)."
      : cloud === "gcp"
        ? "Until the zone is delegated, Google cannot provision the managed certificate, and the name does not serve HTTPS."
        : "Until the zone is delegated, Front Door cannot validate the domain or issue its managed certificate.";
  return [
    `Before you apply: ${domain.fqdn} is served over HTTPS on a certificate validated through`,
    `the ${domain.zoneName} zone this plan creates, which works only once the zone is delegated.`,
    `Create the zone first (terraform apply -target=${zoneAddress}), set the domain's`,
    `name servers at your registrar to the ${nameServersOutput} output, then apply the rest.`,
    waits,
  ].join("\n");
}

/** The Google service agents that read a customer-managed key on behalf of what the plan encrypts. */
const KEY_AGENTS = {
  storage: "data.google_storage_project_service_account",
  pubsub: "google_project_service_identity",
  bigquery: "data.google_bigquery_default_service_account",
} as const;

/**
 * Google Cloud: a plan with a key store puts what it stores at rest under that store's key. Every bucket, Pub/Sub
 * topic and BigQuery dataset that no edge already wired to a key is encrypted under it, and the key lets the service
 * agent of each service use it, once per service; what is encrypted waits for that grant. A plan with no key store
 * leaves them on Google's own encryption, which is why the scanner exceptions for them hold only there.
 */
function encryptUnderKeyStore(emitted: readonly Emitted[], wired: readonly HclBlock[], usedNames: Set<string>, apis: boolean): HclBlock[] {
  const store = emitted.find((e) => e.node.kind === "key-vault");
  if (!store) return [];
  const key = `google_kms_crypto_key.${store.name}.id`;
  const added: HclBlock[] = [];
  const grants = new Map<keyof typeof KEY_AGENTS, string>();
  /** The grant that lets one service's agent use the key, written the first time something needs it. */
  const grantFor = (service: keyof typeof KEY_AGENTS): string => {
    const existing = grants.get(service);
    if (existing) return existing;
    // A bucket an edge already wired to this key has its grant: a second one for the same agent would fight it over the binding.
    const wiredAlready = wired.find(
      (w) =>
        w.type === "resource" &&
        w.labels[0] === "google_kms_crypto_key_iam_member" &&
        attributeOf(w, "crypto_key_id") === key &&
        (attributeOf(w, "member") ?? "").startsWith(`"serviceAccount:\${${KEY_AGENTS[service]}.`),
    );
    if (wiredAlready) {
      const address = `google_kms_crypto_key_iam_member.${wiredAlready.labels[1] ?? ""}`;
      grants.set(service, address);
      return address;
    }
    let name = `${store.name}_${service}`;
    for (let n = 2; usedNames.has(name); n++) name = `${store.name}_${service}_${n}`;
    usedNames.add(name);
    const [data, type] = KEY_AGENTS[service].startsWith("data.") ? [true, KEY_AGENTS[service].slice(5)] : [false, KEY_AGENTS[service]];
    const agent = block(data ? "data" : "resource", [type, name], service === "pubsub" ? [
      { key: "provider", value: GCP_BETA_REF },
      { key: "service", value: quote("pubsub.googleapis.com") },
    ] : []);
    if (apis) addDependsOn(agent, "google_project_service.enabled");
    const email = service === "storage" ? `${KEY_AGENTS[service]}.${name}.email_address` : `${KEY_AGENTS[service]}.${name}.email`;
    const grant = block("resource", ["google_kms_crypto_key_iam_member", name], [
      { key: "crypto_key_id", value: key },
      { key: "role", value: quote("roles/cloudkms.cryptoKeyEncrypterDecrypter") },
      { key: "member", value: `"serviceAccount:\${${email}}"` },
    ]);
    added.push(agent, grant);
    const address = `google_kms_crypto_key_iam_member.${name}`;
    grants.set(service, address);
    return address;
  };
  for (const { blocks } of emitted) {
    for (const b of blocks) {
      if (b.type !== "resource") continue;
      const has = (type: string) => b.blocks.some((x) => x.type === type);
      if (b.labels[0] === "google_storage_bucket" && !has("encryption")) {
        b.blocks.push(block("encryption", [], [{ key: "default_kms_key_name", value: key }]));
        addDependsOn(b, grantFor("storage"));
      } else if (b.labels[0] === "google_pubsub_topic" && !b.attributes.some((a) => a.key === "kms_key_name")) {
        b.attributes.push({ key: "kms_key_name", value: key });
        addDependsOn(b, grantFor("pubsub"));
      } else if (b.labels[0] === "google_bigquery_dataset" && !has("default_encryption_configuration")) {
        b.blocks.push(block("default_encryption_configuration", [], [{ key: "kms_key_name", value: key }]));
        addDependsOn(b, grantFor("bigquery"));
      }
    }
  }
  return added;
}

/** The address a block is referred to by, `type.name`. */
function addressOf(b: HclBlock): string | null {
  return b.type === "resource" && b.labels.length === 2 ? `${b.labels[0]}.${b.labels[1]}` : null;
}

/** Every attribute expression in a block and the blocks nested in it. */
function expressionsOf(b: HclBlock): string[] {
  return [...b.attributes.map((a) => a.value), ...b.blocks.flatMap(expressionsOf)];
}

/**
 * Make every resource of a Google Cloud component that stands on no other resource of it wait
 * for the APIs the plan enables. The ones that do stand on another are ordered by that
 * reference, which is already after the one that waits. The project, when the plan creates it,
 * is what the APIs are enabled in, so it never waits for them.
 */
function waitForApis(group: HclBlock[], project: string | undefined): void {
  const own = new Set(group.map(addressOf).filter((a): a is string => a !== null));
  for (const b of group) {
    const address = addressOf(b);
    if (!address || address === (project ? `google_project.${project}` : "")) continue;
    const references = expressionsOf(b).flatMap((e) => e.match(/\bgoogle_[a-z0-9_]+\.[A-Za-z0-9_]+/g) ?? []);
    if (references.some((r) => r !== address && own.has(r))) continue;
    addDependsOn(b, "google_project_service.enabled");
  }
}

/* ------------------------------------------------------------------- emit -- */

/** A model whose free-text attributes cannot go into a plan; the message says which and why. */
export class ModelAttributeError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The model has values that cannot be used:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    this.name = "ModelAttributeError";
    this.problems = problems;
  }
}

export function emitTerraform(
  model: InfraModel,
  cloud: Cloud,
  tool: TerraformTool = "terraform",
): TerraformOutput {
  const problems = attributeProblems(resourceNodes(model), cloud);
  if (problems.length > 0) throw new ModelAttributeError(problems);
  const config = CLOUD_CONFIG[cloud];
  const provider = providerFor(cloud);

  const emitted: Emitted[] = [];
  /** What the reviewer has to do outside Terraform, written into the plan's header. */
  const notes: string[] = [];
  const usedNames = new Set<string>();
  const variables = new Map<string, VariableSpec>();
  const outputs: Array<{ name: string; value: string }> = [];
  const extraFiles: TerraformFile[] = [];

  // Every block name is settled before anything emits, because the network's
  // address has to be known by the resources placed in it. One network per plan:
  // the first network kind the model holds on this cloud.
  const names = new Map<string, string>();
  for (const node of resourceNodes(model)) {
    if (!cloudSpec(node.kind, cloud)) continue;
    let name = tfName(node.id);
    let suffix = 2;
    while (usedNames.has(name)) name = `${tfName(node.id)}_${suffix++}`;
    usedNames.add(name);
    names.set(node.id, name);
  }
  const networkNode = resourceNodes(model).find((n) => cloudSpec(n.kind, cloud)?.network);
  const net: NetworkRefs | null = networkNode
    ? (cloudSpec(networkNode.kind, cloud)?.network?.(names.get(networkNode.id) ?? tfName(networkNode.id)) ?? null)
    : null;
  // Every Azure plan has a private network: the model's virtual network when it
  // draws one, else one the plan adds for itself.
  const azureNetworkNode = cloud === "azure" ? resourceNodes(model).find((n) => n.kind === "vnet") : undefined;
  const privateNet =
    cloud === "azure"
      ? privateNetwork(azureNetworkNode ? (names.get(azureNetworkNode.id) ?? tfName(azureNetworkNode.id)) : PLAN_NETWORK)
      : null;

  // What Google Cloud kinds ask of the plan: the APIs to switch on, and private service access per network.
  const gcpApis = new Set<string>();
  const gcpPrivateServices = new Map<string, string>();
  const gcp: Omit<GcpPlan, "position"> | null =
    cloud === "gcp"
      ? {
          api: (...services) => {
            for (const service of services) gcpApis.add(service);
          },
          privateServices: (networkId) => {
            if (!gcpPrivateServices.has(networkId)) gcpPrivateServices.set(networkId, "google_service_networking_connection.private_services");
            return "google_service_networking_connection.private_services";
          },
        }
      : null;

  const emittedOfKind = new Map<string, number>();
  for (const node of resourceNodes(model)) {
    const spec = cloudSpec(node.kind, cloud);
    if (!spec) continue;
    const name = names.get(node.id) ?? tfName(node.id);
    const position = emittedOfKind.get(node.kind) ?? 0;
    emittedOfKind.set(node.kind, position + 1);

    const fields = fieldsForKind(node.kind);
    const context: EmitContext = {
      node,
      name,
      slug: tfSlug(node.id),
      attr: (key) => {
        const field = fields.find((f) => f.key === key);
        const value = node.attributes?.[key] ?? field?.fallback ?? "";
        return field?.normalize?.(value) ?? value;
      },
      net,
      private: privateNet?.api ?? null,
      gcp: gcp ? { ...gcp, position } : null,
    };

    const result = spec.emit(context);
    for (const variable of result.variables ?? []) variables.set(variable.name, variable);
    for (const output of result.outputs ?? []) outputs.push(output);
    for (const file of result.files ?? []) extraFiles.push(file);

    const consumer = result.blocks[result.consumer ?? 0] ?? result.blocks[0];
    const referentBlock = result.blocks[result.referent ?? 0] ?? result.blocks[0];
    if (!consumer || !referentBlock) continue;

    emitted.push({
      node,
      spec,
      name,
      context,
      blocks: result.blocks,
      consumer,
      referent: referenceTo(referentBlock, { type: spec.type, name }),
    });
  }

  const byNodeId = new Map(emitted.map((e) => [e.node.id, e]));
  const wireBlocks: HclBlock[] = [];
  const plan: WirePlan = { notes, domains: new Map() };
  // A zone's edges first: what a tier is named decides how the tiers in front
  // of it reach it.
  const fromZone = (id: string) => byNodeId.get(id)?.node.kind === "dns";
  const edges = [...model.edges.filter((e) => fromZone(e.source)), ...model.edges.filter((e) => !fromZone(e.source))];
  for (const edge of edges) {
    const source = byNodeId.get(edge.source);
    const target = byNodeId.get(edge.target);
    if (!source || !target || source === target) continue;
    wireBlocks.push(...wireEdge(source, target, cloud, plan));
  }

  if (cloud === "gcp") wireBlocks.push(...encryptUnderKeyStore(emitted, wireBlocks, usedNames, gcpApis.size > 0));

  // Shapes that are only valid once their edges are known complete themselves
  // last, after every wire has landed.
  for (const item of emitted) {
    for (const variable of item.spec.finalize?.(item.consumer, item.context) ?? []) {
      variables.set(variable.name, variable);
    }
  }

  // The private network, with exactly the subnets and zones the kinds asked for.
  const networkBlocks: HclBlock[] = [];
  if (privateNet && privateNet.subnets.size > 0) {
    const own = azureNetworkNode ? byNodeId.get(azureNetworkNode.id)?.blocks[0] : undefined;
    const network = own ?? planNetwork();
    if (!own) networkBlocks.push(network);
    const space = (azureNetworkNode ? byNodeId.get(azureNetworkNode.id)?.context.attr("Address space") : null) ?? PLAN_ADDRESS_SPACE;
    const octets = /^(\d+)\.(\d+)\./.exec(space.trim());
    const prefix = octets ? `${octets[1]}.${octets[2]}` : "10.0";
    let next = mapEntries(attributeOf(network, "subnets")).length + 1;
    for (const [key, want] of privateNet.subnets) {
      addMapEntry(network, "subnets", {
        key,
        value: mapExpression([
          { key: "name", value: quote(`snet-${key}`) },
          { key: "address_prefix", value: quote(`${prefix}.${next++}.0/24`) },
          ...(want.outbound ? [{ key: "default_outbound_access_enabled", value: "true" }] : []),
          ...(want.delegation
            ? [
                {
                  key: "delegations",
                  value: `[{ name = "delegation", service_delegation = { name = ${quote(want.delegation)} } }]`,
                },
              ]
            : []),
        ]),
      });
    }
    const networkId = `module.${network.labels[0]}.resource_id`;
    const zonePin = MODULE_VERSIONS["azure/private-dns-zone"];
    for (const [zone, tf] of privateNet.zones) {
      networkBlocks.push(
        block("module", [tf], [
          { key: "source", value: quote(zonePin.source) },
          { key: "version", value: quote(zonePin.version) },
          { key: "domain_name", value: quote(zone) },
          { key: "parent_id", value: "module.resource_group.resource_id" },
          {
            key: "virtual_network_links",
            value: mapExpression([
              {
                key: "network",
                value: mapExpression([
                  { key: "name", value: quote(`${tf.replace(/_/g, "-")}-link`) },
                  { key: "virtual_network_id", value: networkId },
                  { key: "autoregistration", value: "false" },
                ]),
              },
            ]),
          },
          { key: "enable_telemetry", value: "false" },
          { key: "tags", value: "local.tags" },
        ]),
      );
    }
    if (privateNet.zones.size > 0) notes.push(privateNetworkNote(`module.${network.labels[0]}`, privateNet.zones.keys()));
  }

  /* ------------------------------------------------------------ documents -- */

  // Bounded above: state written by a newer major cannot be read by an older CLI,
  // so an open-ended floor does not do the one job the constraint has. The Azure
  // floor is the one the Verified Modules themselves require — better said here
  // than discovered halfway through `init`.
  const requiredVersion = cloud === "azure" ? ">= 1.11, < 2.0" : ">= 1.6, < 2.0";
  // A function's source is zipped by the archive provider, which only a plan that has one declares.
  const needsArchive = [...emitted.flatMap((e) => e.blocks), ...wireBlocks].some(
    (b) => b.type === "data" && b.labels[0] === "archive_file",
  );
  // Likewise the beta provider, for the few resources the main one does not have yet.
  const needsBeta = [...emitted.flatMap((e) => e.blocks), ...wireBlocks].some((b) =>
    b.attributes.some((a) => a.key === "provider" && a.value === GCP_BETA_REF),
  );
  const pins = [
    provider,
    ...(needsArchive ? [PROVIDER_VERSIONS.archive] : []),
    ...(needsBeta ? [PROVIDER_VERSIONS["gcp-beta"]] : []),
  ];
  const scaffold: HclBlock[] = [
    block("terraform", [], [{ key: "required_version", value: quote(requiredVersion) }], [
      block("required_providers", [], pins.map((pin) => ({
        key: pin.name,
        value: mapExpression([
          { key: "source", value: quote(pin.source) },
          { key: "version", value: quote(pin.version) },
        ]),
      }))),
    ]),
  ];

  // Ownership and cost allocation, in one place, on every resource. The base set
  // is what the plan itself knows; `var.tags` is merged over it, so a reviewer's
  // Owner and CostCentre win and nothing here has to guess them.
  if (emitted.length > 0 && cloud === "gcp") {
    // Google Cloud calls them labels, and takes lowercase keys and values only.
    variables.set(GCP_LABELS.name, GCP_LABELS);
    const base = `{ managed_by = "diagram", environment = "${modelIsProduction(model.nodes) ? "production" : "dev"}" }`;
    scaffold.push(block("locals", [], [{ key: "labels", value: `merge(${base}, var.labels)` }]));
  } else if (emitted.length > 0) {
    variables.set(TAGS.name, TAGS);
    // One line on purpose: `terraform fmt` leaves a single-line object alone,
    // and this one is short enough to read at a glance.
    const base = `{ ManagedBy = "diagram", Environment = "${modelIsProduction(model.nodes) ? "production" : "dev"}" }`;
    scaffold.push(block("locals", [], [{ key: "tags", value: `merge(${base}, var.tags)` }]));
  }

  if (cloud === "azure") {
    scaffold.push(block("provider", ["azurerm"], [], [block("features", [], [])]));
    if (emitted.length > 0) {
      // Even the resource group is a Verified Module — the plan has no
      // hand-written Azure resource left to be inconsistent with.
      scaffold.push(
        block("module", ["resource_group"], [
          { key: "source", value: quote(MODULE_VERSIONS["azure/resource-group"].source) },
          { key: "version", value: quote(MODULE_VERSIONS["azure/resource-group"].version) },
          { key: "name", value: quoteTemplate`rg-\${var.name_prefix}` },
          { key: "location", value: "var.location" },
          { key: "enable_telemetry", value: "false" },
          { key: "tags", value: "local.tags" },
        ]),
      );
    }
    variables.set("location", {
      name: "location",
      type: "string",
      description: "Azure region every resource is created in.",
      default: quote(config.region),
    });
  } else if (cloud === "gcp") {
    scaffold.push(
      block("provider", ["google"], [
        { key: "project", value: "var.project_id" },
        { key: "region", value: "var.region" },
        emitted.length > 0 ? { key: "default_labels", value: "local.labels" } : undefined,
      ]),
    );
    if (needsBeta) {
      scaffold.push(
        block("provider", [GCP_BETA_REF], [
          { key: "project", value: "var.project_id" },
          { key: "region", value: "var.region" },
          { key: "default_labels", value: "local.labels" },
        ]),
      );
    }
    variables.set("project_id", {
      name: "project_id",
      type: "string",
      description: "ID of the project every resource is created in.",
    });
    variables.set("region", {
      name: "region",
      type: "string",
      description: "Google Cloud region every resource is created in.",
      default: quote(config.region),
    });
  } else {
    scaffold.push(
      block("provider", ["aws"], [{ key: "region", value: "var.region" }],
        emitted.length > 0
          ? [block("default_tags", [], [{ key: "tags", value: "local.tags" }])]
          : [],
      ),
    );
    // Declared only when something needs it: a plan with no CloudFront has no
    // reason to configure a second region.
    const needsUsEast1 = [...emitted.flatMap((e) => e.blocks), ...wireBlocks].some((b) =>
      b.attributes.some((a) => a.key === "provider" && a.value === AWS_US_EAST_1.ref),
    );
    if (needsUsEast1) {
      scaffold.push(
        block("provider", ["aws"], [
          { key: "alias", value: quote(AWS_US_EAST_1.alias) },
          { key: "region", value: quote(AWS_US_EAST_1.region) },
        ], [block("default_tags", [], [{ key: "tags", value: "local.tags" }])]),
      );
    }
    variables.set("region", {
      name: "region",
      type: "string",
      description: "AWS region every resource is created in.",
      default: quote(config.region),
    });
  }

  // Google Cloud: the plan switches on the APIs its kinds use, and gives databases and caches the
  // private service connection they reach their network through. Every resource that stands on
  // nothing else in its component waits for the APIs, so a first apply does not race them.
  const gcpBlocks: HclBlock[] = [];
  if (cloud === "gcp") {
    const groups: HclBlock[][] = emitted.map((e) => e.blocks);
    for (const networkId of gcpPrivateServices.keys()) {
      const blocks = privateServicesBlocks(networkId);
      gcpBlocks.push(...blocks);
      groups.push(blocks);
    }
    if (gcpApis.size > 0) {
      const project = emitted.find((e) => e.node.kind === "project");
      gcpBlocks.unshift(
        block("resource", ["google_project_service", "enabled"], [
          { key: "for_each", value: `toset([${[...gcpApis].sort(compareText).map(quote).join(", ")}])` },
          project ? { key: "project", value: `google_project.${project.name}.project_id` } : undefined,
          { key: "service", value: "each.value" },
          { key: "disable_on_destroy", value: "false" },
        ]),
      );
      for (const group of groups) waitForApis(group, project?.name);
    }
  }

  const resourceBlocks = [...networkBlocks, ...emitted.flatMap((e) => e.blocks), ...gcpBlocks];
  const modules: ModuleCall[] = resourceBlocks
    .filter((b) => b.type === "module")
    .map((b) => ({
      name: b.labels[0] ?? "",
      source: stringValue(attributeOf(b, "source")) ?? "",
      version: stringValue(attributeOf(b, "version")) ?? "",
    }));
  // Data sources are lookups, not things the plan creates, so they are not counted.
  const rawCount = [...resourceBlocks, ...wireBlocks].filter((b) => b.type === "resource").length;
  const header = [
    `# Generated from the diagram model`,
    `# Target: ${config.label} · ${config.regionLabel} · ${TOOL_LABEL[tool]}`,
    `# ${modules.length} module ${modules.length === 1 ? "call" : "calls"} and ${rawCount} resources from ${emitted.length} components`,
    ...notes.flatMap((note) => ["#", ...note.split("\n").map((line) => `# ${line}`)]),
  ].join("\n");

  const mainTf = `${header}\n\n${renderDocument([...scaffold, ...resourceBlocks, ...wireBlocks])}`;

  const variableBlocks = [...variables.values()]
    .sort((a, b) => compareText(a.name, b.name))
    .map((variable) =>
      block("variable", [variable.name], [
        { key: "type", value: variable.type },
        { key: "description", value: variable.description ? quote(variable.description) : undefined },
        { key: "sensitive", value: variable.sensitive ? "true" : undefined },
        { key: "default", value: variable.default },
      ], variable.validation
        ? [
            block("validation", [], [
              { key: "condition", value: variable.validation.condition },
              { key: "error_message", value: quote(variable.validation.message) },
            ]),
          ]
        : []),
    );

  const seenOutputs = new Set<string>();
  const outputBlocks = outputs
    .filter((o) => {
      if (seenOutputs.has(o.name)) return false;
      seenOutputs.add(o.name);
      return true;
    })
    .map((output) => block("output", [output.name], [{ key: "value", value: output.value }]));

  return {
    provider: provider.name,
    providerVersion: provider.version,
    region: config.region,
    regionLabel: config.regionLabel,
    tool,
    modules,
    extraProviders: pins.slice(1).map((pin) => ({ name: pin.name, version: pin.version })),
    files: [
      { name: "main.tf", content: mainTf },
      {
        name: "variables.tf",
        content:
          variableBlocks.length > 0
            ? renderDocument(variableBlocks)
            : "# No variables — add resources to the model to populate this file.\n",
      },
      {
        name: "outputs.tf",
        content:
          outputBlocks.length > 0
            ? renderDocument(outputBlocks)
            : "# No outputs — add resources to the model to populate this file.\n",
      },
      ...extraFiles,
    ],
  };
}
