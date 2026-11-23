// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { composeFromPrompt } from "terragram-engine/engine";
import type { InfraModel } from "terragram-engine/model";
import { contentHashFor } from "terragram-engine/receipt";

/**
 * Prints the content hash of one model, under the v3 canonical form and the original
 * serialization, in whatever locale this process was started with. The test that spawns
 * it sets `LC_ALL`, so the same model is hashed under different ICU default locales.
 */

const IDS = ["å", "ä", "z", "a", "Z", "ö", "e", "é", "ø", "o"];

export function nonAsciiModel(): InfraModel {
  const { model } = composeFromPrompt("A web app with a Postgres database and Redis cache");
  const renamed = new Map(model.nodes.map((n, i) => [n.id, IDS[i % IDS.length] + String(i)] as const));
  const rename = (id: string) => renamed.get(id) ?? id;
  return {
    ...model,
    nodes: model.nodes.map((n, i) => ({
      ...n,
      id: rename(n.id),
      attributes: { ...n.attributes, å: "1", z: "2", a: "3", Ä: String(i) },
    })),
    edges: model.edges.map((e) => ({ ...e, source: rename(e.source), target: rename(e.target) })),
  };
}

if (import.meta.main) {
  const args = { model: nonAsciiModel(), cloud: "azure" as const, files: [{ name: "main.tf", content: "x" }], order: ["main.tf"] };
  console.log(
    JSON.stringify({
      locale: new Intl.Collator().resolvedOptions().locale,
      v3: await contentHashFor(args),
      v2: await contentHashFor(args, "diagram.receipt/v2"),
    }),
  );
}
