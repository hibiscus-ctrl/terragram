// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Write the open JSON Schemas for the engine's documents, or check they are current.
 *
 *   npm run schemas:gen     write schemas/*.schema.json
 *   npm run schemas:check   fail when a committed schema differs from what the zod
 *                           schemas in packages/engine generate (CI runs this)
 *
 * The schemas are generated, never hand-edited: the engine's zod schemas are what
 * the code enforces, so a schema derived from them cannot drift from the code, and
 * the check makes a change to either one show up in the diff of the other.
 *
 * `io: "input"` describes what a reader may send: a field with a default (a node's
 * `flag`, an edge's `origin`, the model's `topology`) is optional there. Unknown
 * properties are allowed, as they are by the engine, which strips them.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { graphLayoutSchema, MAX_GRAPH_NODES } from "terragram-engine/graph";
import { modelDocumentSchema } from "terragram-engine/model";
import { evidenceReceiptSchema, legacyEvidenceReceiptSchema } from "terragram-engine/receipt-schema";

/** Where the published schemas live, until they have a home of their own. */
const ID_BASE = "https://github.com/hibiscus-ctrl/terragram/schemas";

type SchemaSpec = {
  file: string;
  title: string;
  description: string;
  schema: z.ZodType;
};

const SCHEMAS: SchemaSpec[] = [
  {
    file: "graph-layout.v2.schema.json",
    title: "Estate graph layout (diagram.graph-layout/v2)",
    description:
      `An infraharvest graph/v1 estate laid out as plain data: nodes and boxes with their rectangles, edges with their routes, and the badges (change, findings) each carries. These are the coordinates the engine's SVG is drawn from, so a viewer that places them draws the same picture. Every string is plain text, never markup. At most ${MAX_GRAPH_NODES} nodes; \`cut\` says when an estate was cut.`,
    schema: graphLayoutSchema,
  },
  {
    file: "model.v1.schema.json",
    title: "Diagram model (diagram.model/v1)",
    description:
      "An infrastructure diagram as the engine reads it: components (nodes, at most 300) and the connections between them (edges, at most 600), optionally with the cloud it targets. A bare model, as found in an evidence bundle's model.json, is valid.",
    schema: modelDocumentSchema,
  },
  {
    file: "receipt.v3.schema.json",
    title: "Diagram evidence receipt (diagram.receipt/v3)",
    description:
      "The receipt.json of an evidence bundle: the content hash over the approved model and plan, the detached signature and the key that checks it, and who produced what.",
    schema: evidenceReceiptSchema,
  },
  {
    file: "receipt.v2.schema.json",
    title: "Diagram evidence receipt (diagram.receipt/v2)",
    description:
      "The receipt.json of an evidence bundle: the content hash over the approved model and plan, the detached signature and the key that checks it, and who produced what.",
    schema: legacyEvidenceReceiptSchema,
  },
];

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** One schema's JSON text, exactly as it is committed. */
function renderSchema(spec: SchemaSpec): string {
  const body = z.toJSONSchema(spec.schema, {
    target: "draft-2020-12",
    io: "input",
    // zod bounds an integer to the safe range; that is noise in a published schema.
    override: ({ jsonSchema }) => {
      if (jsonSchema.maximum === MAX_SAFE) delete jsonSchema.maximum;
      if (jsonSchema.minimum === -MAX_SAFE) delete jsonSchema.minimum;
    },
  });
  const { $schema, ...rest } = body;
  const document = {
    $schema,
    $id: `${ID_BASE}/${spec.file}`,
    title: spec.title,
    description: spec.description,
    ...rest,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const check = process.argv.includes("--check");
let stale = 0;

for (const spec of SCHEMAS) {
  const path = join(dir, spec.file);
  const next = renderSchema(spec);
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== next) {
      stale++;
      console.error(`schemas/${spec.file} is out of date`);
    }
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, next);
    console.log(`wrote schemas/${spec.file}`);
  }
}

if (stale > 0) {
  console.error("run `npm run schemas:gen` and commit the result");
  process.exit(1);
}
