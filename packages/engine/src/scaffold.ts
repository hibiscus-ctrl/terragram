// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type HclBlock, attributeOf, block, mapEntries, mapExpression, quote, quoteTemplate, stringValue } from "./hcl.ts";
import { MODULE_VERSIONS } from "./module-versions.ts";

/**
 * The module calls an Azure plan adds around its components (the resource group, the network it
 * makes when the model draws none, the private DNS zones) and the one test that tells them from a
 * module of the file's own. The generator builds them here, and the reader compares a block with
 * what the same builder writes, so the two cannot drift apart: a block is scaffold only when it is
 * exactly that **and** a component of the file uses it. A lookalike is drawn.
 */

/** The module name of the network an Azure plan adds when the model draws none. */
export const PLAN_NETWORK = "network";

/** The address space of the network an Azure plan adds when the model draws none. */
export const PLAN_ADDRESS_SPACE = "10.0.0.0/16";

/** The module name of the plan's resource group. */
const RESOURCE_GROUP = "resource_group";

/** The resource group every Azure component of a plan is placed in: a Verified Module like the rest. */
export function resourceGroupModule(): HclBlock {
  const pin = MODULE_VERSIONS["azure/resource-group"];
  return block("module", [RESOURCE_GROUP], [
    { key: "source", value: quote(pin.source) },
    { key: "version", value: quote(pin.version) },
    { key: "name", value: quoteTemplate`rg-\${var.name_prefix}` },
    { key: "location", value: "var.location" },
    { key: "enable_telemetry", value: "false" },
    { key: "tags", value: "local.tags" },
  ]);
}

/** The network a plan adds for itself: one address space; the subnets its kinds ask for are added once they have all asked. */
export function planNetworkModule(): HclBlock {
  const pin = MODULE_VERSIONS["azure/virtual-network"];
  return block("module", [PLAN_NETWORK], [
    { key: "source", value: quote(pin.source) },
    { key: "version", value: quote(pin.version) },
    { key: "name", value: quoteTemplate`vnet-\${var.name_prefix}` },
    { key: "parent_id", value: `module.${RESOURCE_GROUP}.resource_id` },
    { key: "location", value: `module.${RESOURCE_GROUP}.location` },
    { key: "address_space", value: `[${quote(PLAN_ADDRESS_SPACE)}]` },
    { key: "enable_telemetry", value: "false" },
    { key: "tags", value: "local.tags" },
  ]);
}

/** The module name of the private DNS zone `zone` (`privatelink.vaultcore.azure.net` -> `private_dns_vaultcore`). */
export function privateDnsZoneName(zone: string): string {
  return `private_dns_${zone.replace(/^privatelink\./, "").split(".")[0]?.replace(/[^a-z0-9]+/g, "_")}`;
}

/** A private DNS zone linked to the network whose resource id is `networkId`. */
export function privateDnsZoneModule(zone: string, networkId: string): HclBlock {
  const pin = MODULE_VERSIONS["azure/private-dns-zone"];
  const name = privateDnsZoneName(zone);
  return block("module", [name], [
    { key: "source", value: quote(pin.source) },
    { key: "version", value: quote(pin.version) },
    { key: "domain_name", value: quote(zone) },
    { key: "parent_id", value: `module.${RESOURCE_GROUP}.resource_id` },
    {
      key: "virtual_network_links",
      value: mapExpression([
        {
          key: "network",
          value: mapExpression([
            { key: "name", value: quote(`${name.replace(/_/g, "-")}-link`) },
            { key: "virtual_network_id", value: networkId },
            { key: "autoregistration", value: "false" },
          ]),
        },
      ]),
    },
    { key: "enable_telemetry", value: "false" },
    { key: "tags", value: "local.tags" },
  ]);
}

/** Whitespace runs as one space, so a plan `terraform fmt` realigned still compares equal. */
export const squash = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * Whether `actual` carries the attributes of `expected` and no others, each once, with the same
 * values (but for the `skip` keys, which only have to be there), and no nested blocks. A module's
 * `version` is skipped: a plan written when the pins were older is still the generator's.
 */
export function sameAttributes(actual: HclBlock, expected: HclBlock, skip: readonly string[] = ["version"]): boolean {
  if (actual.blocks.length > 0 || actual.attributes.length !== expected.attributes.length) return false;
  return expected.attributes.every((e) => {
    const found = actual.attributes.filter((a) => a.key === e.key);
    const [one] = found;
    if (found.length !== 1 || one === undefined) return false;
    return skip.includes(e.key) ? stringValue(one.value) !== undefined : squash(one.value) === squash(e.value);
  });
}

const sourceOf = (b: HclBlock): string | undefined => stringValue(attributeOf(b, "source"));

/** Every expression a block holds, nested blocks included. */
function expressionsOf(b: HclBlock): string[] {
  return [...b.attributes.map((a) => a.value), ...b.blocks.flatMap(expressionsOf)];
}

/** Whether `text` names `address` as a whole reference (`module.network.x`, not `module.network_2.x`). */
function names(text: string, address: string): boolean {
  for (let at = text.indexOf(address); at !== -1; at = text.indexOf(address, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text[at + address.length] ?? "";
    if (!/[\w.-]/.test(before) && !/[\w-]/.test(after)) return true;
  }
  return false;
}

const refers = (b: HclBlock, label: string): boolean => expressionsOf(b).some((e) => names(e, `module.${label}`));

/** The subnets an Azure plan adds to its network: a name, a /24, and the delegation or outbound access a kind asked for. */
function subnetsAreThePlans(value: string | undefined): boolean {
  const subnets = mapEntries(value);
  return (
    new Set(subnets.map((s) => s.key)).size === subnets.length &&
    subnets.every((s) => {
      const own = mapEntries(s.value);
      const get = (key: string) => squash(own.find((e) => e.key === key)?.value);
      const allowed = ["name", "address_prefix", "default_outbound_access_enabled", "delegations"];
      return (
        /^[a-z0-9-]+$/.test(s.key) &&
        own.length === new Set(own.map((e) => e.key)).size &&
        own.every((e) => allowed.includes(e.key)) &&
        get("name") === `"snet-${s.key}"` &&
        /^"\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24"$/.test(get("address_prefix")) &&
        (own.every((e) => e.key !== "default_outbound_access_enabled") || get("default_outbound_access_enabled") === "true") &&
        (own.every((e) => e.key !== "delegations") || /^\[\{ name = "delegation", service_delegation = \{ name = "[A-Za-z0-9./]+" \} \}\]$/.test(get("delegations")))
      );
    })
  );
}

/** What a block looks like, before asking whether anything uses it: the generator's resource group, network or zone. */
function shapeOf(b: HclBlock, all: readonly HclBlock[]): "resource-group" | "network" | "zone" | undefined {
  if (b.type !== "module" || b.labels.length !== 1) return undefined;
  const label = b.labels[0] ?? "";
  const source = sourceOf(b);
  if (source === MODULE_VERSIONS["azure/resource-group"].source) {
    return label === RESOURCE_GROUP && sameAttributes(b, resourceGroupModule()) ? "resource-group" : undefined;
  }
  if (source === MODULE_VERSIONS["azure/virtual-network"].source) {
    if (label !== PLAN_NETWORK) return undefined;
    const { attributes, ...rest } = b;
    const own = { ...rest, attributes: attributes.filter((a) => a.key !== "subnets") };
    return sameAttributes(own, planNetworkModule()) && subnetsAreThePlans(attributeOf(b, "subnets")) ? "network" : undefined;
  }
  if (source === MODULE_VERSIONS["azure/private-dns-zone"].source) {
    const zone = stringValue(attributeOf(b, "domain_name"));
    const network = /^module\.([A-Za-z0-9_-]+)\.resource_id$/.exec(squash(mapEntries(mapEntries(attributeOf(b, "virtual_network_links"))[0]?.value).find((e) => e.key === "virtual_network_id")?.value))?.[1];
    if (zone === undefined || network === undefined || !/^privatelink\.[a-z0-9.-]+$/.test(zone) || label !== privateDnsZoneName(zone)) return undefined;
    const linked = all.some((o) => o.type === "module" && o.labels[0] === network && sourceOf(o) === MODULE_VERSIONS["azure/virtual-network"].source);
    return linked && sameAttributes(b, privateDnsZoneModule(zone, `module.${network}.resource_id`)) ? "zone" : undefined;
  }
  return undefined;
}

/**
 * Whether a module call is something an Azure plan adds around its components rather than a component
 * of the file's own: the resource group, the network added when the model draws none, or a private DNS
 * zone, each exactly as the generator writes it, and each used by a block that is not itself one of those.
 * A resource group named otherwise or carrying another input, a virtual network that is the file's own
 * (even one called `network`), and a zone nothing reads are drawn.
 */
export function isAzureScaffold(b: HclBlock, all: readonly HclBlock[]): boolean {
  const shape = shapeOf(b, all);
  if (shape === undefined) return false;
  const label = b.labels[0] ?? "";
  const drawn = (user: HclBlock) => user !== b && shapeOf(user, all) === undefined && refers(user, label);
  if (all.some(drawn)) return true;
  // The network is also used through a zone that is itself used.
  return shape === "network" && all.some((z) => z !== b && shapeOf(z, all) === "zone" && refers(z, label) && all.some((u) => u !== z && shapeOf(u, all) === undefined && refers(u, z.labels[0] ?? "")));
}
