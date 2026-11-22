// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import { type HclBlock, parseHcl } from "terragram-engine/hcl";

/**
 * Differential oracle — Terragram's HCL reader against the real `hashicorp/hcl`.
 *
 * `hcl.ts` is a hand-written structural reader, and until this file every test of
 * it used HCL we wrote ourselves or that our own emitter produced. Both halves of
 * the test were ours. `@cdktf/hcl2json` is HashiCorp's parser compiled to WASM
 * (MPL-2.0, dev-only, never ships): its whole value here is being a parser we
 * did NOT write. The corpus is third-party too — a pinned terraform-aws-modules
 * release, Apache-2.0, chosen because it is dense with `dynamic`, `for_each`,
 * `count`, `locals` and `data`, none of which the emitter ever produces and all
 * of which a customer's pasted Terraform will contain.
 *
 * WHAT IS COMPARED: the set of top-level blocks (type + labels) and, for each,
 * the set of top-level argument names — attributes and nested-block types
 * together, which is what both readers report. Values are never compared: the
 * reader does not evaluate expressions and is not meant to.
 *
 * WHAT DISAGREEMENT MEANS: a file hcl2json refuses is excluded and logged —
 * hcl2json is strict where the reader is deliberately tolerant. A file both parse
 * where the sets differ is a bug in ours.
 *
 * The package's declarations pull in lib.dom; importing by a `string` specifier
 * keeps them out of the program, and only the one function used is typed here.
 */
const HCL2JSON_SPECIFIER: string = "@cdktf/hcl2json";
type Hcl2Json = { parse: (filename: string, hcl: string) => Promise<Record<string, unknown>> };
const { parse } = (await import(HCL2JSON_SPECIFIER)) as Hcl2Json;

const FIXTURES = join(import.meta.dirname, "fixtures", "hcl-oracle");

function walkTf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTf(full));
    else if (entry.endsWith(".tf")) out.push(full);
  }
  return out;
}

const files: Array<[string, string]> = walkTf(FIXTURES).map((f) => [
  relative(FIXTURES, f).replace(/\\/g, "/"),
  readFileSync(f, "utf8"),
]);

/**
 * hcl2json nests a labelled block as `keyword[label1][label2]` and makes the
 * innermost value an array (repeated blocks are preserved as elements); an
 * unlabelled block (`locals`, `terraform`) is `keyword: [body, …]`. A nested block
 * is a key whose value is an array of bodies, so a body's key set is exactly the
 * argument-name set our reader reports.
 *
 * The one legitimate difference is normalised, not hidden: hcl2json reports the
 * SYNTAX of `dynamic "x" { … }` under the key `dynamic`; our reader records `x`,
 * the argument the block generates — the reading that makes a `dynamic` block
 * and the attribute it replaces compare as the same configuration.
 */
function bodiesFromJson(doc: Record<string, unknown>, type: string, labels: string[]): Array<Record<string, unknown>> {
  let node: unknown = doc[type];
  for (const label of labels) {
    if (typeof node !== "object" || node === null) return [];
    node = (node as Record<string, unknown>)[label];
  }
  const list = Array.isArray(node) ? node : node === undefined ? [] : [node];
  return list.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
}

function namesFromJson(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "dynamic" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      names.push(...Object.keys(value));
      continue;
    }
    names.push(key);
  }
  return [...new Set(names)].sort();
}

function namesFromOurs(block: HclBlock): string[] {
  const names = new Set<string>();
  for (const a of block.attributes) names.add(a.key);
  for (const b of block.blocks) names.add(b.type === "dynamic" ? (b.labels[0] ?? "dynamic") : b.type);
  return [...names].sort();
}

/** Every top-level block hcl2json saw, as `type "l1" "l2"` addresses. */
function addressesFromJson(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (node: unknown, type: string, labels: string[], depth: number) => {
    if (Array.isArray(node)) {
      out.push(`${type} ${labels.map((l) => `"${l}"`).join(" ")}`.trim());
      return;
    }
    if (typeof node !== "object" || node === null) return;
    // resource/data/module/variable/output/provider nest by label; others are bodies.
    const nests = ["resource", "data", "module", "variable", "output", "provider", "terraform", "locals", "moved", "import", "check"];
    if (depth === 0 && !nests.includes(type)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) visit(value, type, [...labels, key], depth + 1);
  };
  for (const [type, value] of Object.entries(doc)) {
    if (["terraform", "locals"].includes(type)) out.push(type);
    else visit(value, type, [], 0);
  }
  return out.sort();
}

describe("HCL differential oracle (@cdktf/hcl2json)", () => {
  assert.ok(files.length >= 5, `expected a fixture corpus under ${FIXTURES}`);

  for (const [label, hcl] of files) {
    it(`agrees with hashicorp/hcl on ${label}`, async () => {
      let doc: Record<string, unknown>;
      try {
        doc = await parse(label, hcl);
      } catch (error) {
        // Strict parser, tolerant reader: a refusal is logged, not a disagreement.
        console.log(`  hcl2json refused ${label}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const ours = parseHcl(hcl);

      // Every block we found, hcl2json found — and with the same arguments.
      const theirs = new Set(addressesFromJson(doc));
      for (const block of ours) {
        const address = `${block.type} ${block.labels.map((l) => `"${l}"`).join(" ")}`.trim();
        assert.ok(theirs.has(address), `${label}: we read ${address}; hcl2json did not`);
        const bodies = bodiesFromJson(doc, block.type, block.labels);
        // A repeated unlabelled block (two `locals {}`) is matched by position.
        const twin = bodies[ours.filter((b) => b.type === block.type && b.labels.join() === block.labels.join()).indexOf(block)];
        if (!twin) continue;
        assert.deepEqual(namesFromOurs(block), namesFromJson(twin), `${label}: arguments of ${address}`);
      }
      // And nothing hcl2json found is missing on our side.
      const oursAddresses = new Set(ours.map((b) => `${b.type} ${b.labels.map((l) => `"${l}"`).join(" ")}`.trim()));
      for (const address of theirs) {
        assert.ok(oursAddresses.has(address), `${label}: hcl2json read ${address}; we did not`);
      }
    });
  }
});
