// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writes the four Google Cloud plans of the emit gate (`scripts/emit-plans.ts`) as Terraform roots, one directory
 * each under `--out`, for the sandbox workflow to apply: `node scripts/sandbox-gcp-plans.ts --out <dir>`.
 *
 * The plans are generated the way `validate-emit.ts` generates them, from their kinds, by the engine the CLI
 * is bundled from: `terragram generate` reads a brief or a Mermaid diagram, which cannot name a plan's kinds
 * one for one. Each is then changed for a sandbox project by `lib/sandbox-gcp.ts`, which lists what.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { assembleModel } from "terragram-engine/engine";
import { emitTerraform } from "terragram-engine/terraform";
import { GCP_PLANS } from "./emit-plans.ts";
import { adaptForSandbox, SANDBOX_ADAPTATIONS } from "./lib/sandbox-gcp.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, summary: { type: "boolean", default: false } } });
if (values.summary) {
  // Markdown for the workflow's summary: what the run leaves out or changes, per plan.
  for (const plan of GCP_PLANS) {
    const changes = SANDBOX_ADAPTATIONS[plan.id] ?? [];
    console.log(`- **${plan.id}**: ${changes.length === 0 ? "applied as generated." : ""}`);
    for (const change of changes) console.log(`  - ${change}`);
  }
  process.exit(0);
}
if (values.out === undefined) {
  console.error("usage: node scripts/sandbox-gcp-plans.ts --out <dir> | --summary");
  process.exit(2);
}
const out = resolve(values.out);

for (const plan of GCP_PLANS) {
  const generated = emitTerraform(assembleModel(plan.kinds, undefined, true).model, "gcp", "terraform").files;
  for (const file of adaptForSandbox(plan.id, generated)) {
    const path = join(out, plan.id, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  const left = SANDBOX_ADAPTATIONS[plan.id] ?? [];
  console.log(`${plan.id}: ${left.length === 0 ? "as generated" : `${left.length} change${left.length === 1 ? "" : "s"} for a sandbox project`}`);
}
