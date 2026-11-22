// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Check every `module` block the emitter writes against the module's REAL
 * published interface.
 *
 * The kind registry names a registry module and a set of inputs. Nothing forced
 * those input names to exist: they were read off the registry by hand once, and a
 * module bump that renames or removes one would quietly start producing HCL that
 * `terraform validate` rejects — found, if at all, by a customer.
 *
 * This asks the Terraform registry what each pinned module version actually
 * accepts and requires, then checks both directions:
 *
 *   - every input the emitter writes is a real input of that module version;
 *   - every input the module marks REQUIRED is one the emitter supplies.
 *
 * The emitted inputs are read by running the emitter, not from a second list, so
 * this cannot drift from what the product writes.
 *
 *   npm run check:modules
 *
 * Network-dependent by design — it is the release-time check that the pins in
 * `module-versions.ts` are still the interface the emitter was written against.
 * It runs as part of `npm run refresh:providers`, so bumping a pin proves the
 * bump before it lands. Exit code is the number of modules with a mismatch.
 */
import { errorMessage } from "@infraweaver-io/core/errors";

import { attributeOf, type HclBlock, parseHcl, stringValue } from "terragram-engine/hcl";
import { KIND_DEFINITIONS } from "terragram-engine/kinds";
import { addNode } from "terragram-engine/inspector";
import { type Cloud, CLOUDS, EMPTY_MODEL } from "terragram-engine/model";
import { emitTerraform } from "terragram-engine/terraform";

const REGISTRY = "https://registry.terraform.io/v1/modules";

/** Inputs every module call carries that are not the module's own interface. */
const META_ARGUMENTS = new Set(["source", "version", "count", "for_each", "providers", "depends_on"]);

type RegistryInput = { name: string; required: boolean };

/** Fetch one module version's root (or submodule) inputs. */
async function fetchInputs(source: string, version: string): Promise<RegistryInput[]> {
  const [address, subdir] = source.split("//");
  const response = await fetch(`${REGISTRY}/${address}/${version}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${source} ${version}: registry returned ${response.status}`);
  const body = (await response.json()) as {
    root?: { inputs?: RegistryInput[] };
    submodules?: Array<{ path?: string; inputs?: RegistryInput[] }>;
  };
  if (!subdir) return body.root?.inputs ?? [];
  const found = body.submodules?.find((s) => s.path === subdir);
  if (!found) throw new Error(`${source} ${version}: no submodule at "${subdir}"`);
  return found.inputs ?? [];
}

/** Every module block the emitter writes for a kind on a cloud, as (source, keys). */
function emittedModules(kind: string, cloud: Cloud): Array<{ source: string; version: string; keys: string[] }> {
  const alone = addNode(EMPTY_MODEL, kind);
  if (!alone) return [];
  // Once alone and once beside a network: a kind placed in a VPC writes inputs
  // (`subnet_ids`, `create_db_subnet_group`) it does not write on its own.
  const inNetwork = kind === "vnet" ? null : addNode(alone.model, "vnet");
  const models = [alone.model, ...(inNetwork ? [inNetwork.model] : [])];
  const blocks = models
    .flatMap((m) => emitTerraform(m, cloud).files)
    .filter((f) => f.name.endsWith(".tf"))
    .flatMap((f) => parseHcl(f.content))
    .filter((b: HclBlock) => b.type === "module");
  return blocks.map((b) => ({
    source: stringValue(attributeOf(b, "source")) ?? "",
    version: stringValue(attributeOf(b, "version")) ?? "",
    keys: b.attributes.map((a) => a.key).filter((k) => !META_ARGUMENTS.has(k)),
  }));
}

/** Union the inputs used across every kind that calls the same module. */
const calls = new Map<string, { version: string; keys: Set<string>; kinds: Set<string> }>();
for (const definition of KIND_DEFINITIONS) {
  for (const cloud of CLOUDS) {
    const spec = cloud === "azure" ? definition.azure : definition.aws;
    if (!spec?.moduleSource) continue;
    for (const call of emittedModules(definition.kind, cloud)) {
      if (!call.source) continue;
      const entry = calls.get(call.source) ?? {
        version: call.version,
        keys: new Set<string>(),
        kinds: new Set<string>(),
      };
      for (const key of call.keys) entry.keys.add(key);
      entry.kinds.add(`${definition.kind}/${cloud}`);
      calls.set(call.source, entry);
    }
  }
}

if (calls.size === 0) {
  console.log("No module-based kinds — nothing to check.");
  process.exit(0);
}

let failed = 0;
for (const [source, call] of [...calls].sort(([a], [b]) => a.localeCompare(b))) {
  let inputs: RegistryInput[];
  try {
    inputs = await fetchInputs(source, call.version);
  } catch (error) {
    console.log(`FAIL  ${source}@${call.version}`);
    console.log(`        ${errorMessage(error)}`);
    failed++;
    continue;
  }

  const known = new Set(inputs.map((i) => i.name));
  const unknown = [...call.keys].filter((k) => !known.has(k)).sort();
  const missing = inputs
    .filter((i) => i.required && !call.keys.has(i.name))
    .map((i) => i.name)
    .sort();

  if (unknown.length === 0 && missing.length === 0) {
    console.log(`PASS  ${source}@${call.version}  (${call.keys.size} inputs · ${[...call.kinds].join(", ")})`);
    continue;
  }
  failed++;
  console.log(`FAIL  ${source}@${call.version}  (${[...call.kinds].join(", ")})`);
  if (unknown.length > 0) {
    console.log(`        not an input of this version: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    console.log(`        required but not supplied: ${missing.join(", ")}`);
  }
}

console.log(`\n${calls.size - failed}/${calls.size} module calls match their published interface`);
process.exit(failed);
