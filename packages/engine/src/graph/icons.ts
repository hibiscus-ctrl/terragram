// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanText } from "./text.ts";
import type { GraphCategory, GraphLevel } from "./view.ts";

/**
 * A picture of a service on a card, chosen by whoever draws: the engine ships no vendor art, so a web app that has the clouds'
 * icons passes a resolver that says which one a node gets. A node the resolver gives nothing for (or a picture drawn
 * with no resolver) shows the engine's own glyph of the node's category (see `CATEGORY_GLYPHS`).
 *
 * The resolver is called once per node, with what the table knows of it, and answers with where the picture is:
 * `{ href }` (an `https:` URL, a `data:image/` URI or a path) or `{ symbol }` (the id of an SVG `<symbol>` in the page that
 * inlines the picture; a standalone SVG file has no such page, so it should be given hrefs). The answer is data, so the layout
 * carries it to a viewer that draws the picture itself. The Overview level's summary cards stand for no service and are not asked.
 */
export type IconQuery = {
  /** The node's id in the picture. */
  id: string;
  cloud: "aws" | "azure" | "google";
  /** The resource type (for a card of several resources, the most numerous type among them). */
  type: string;
  /** The service id: `aws.rds`, `azure.sql`, `gcp.gke`, or a fallback `aws.data`. */
  service: string;
  category: GraphCategory;
  level: GraphLevel;
};

export type IconRef = { href: string } | { symbol: string };
export type IconResolver = (node: IconQuery) => IconRef | undefined;

const MAX_HREF = 32768;
const SYMBOL = /^[A-Za-z_][\w.:-]{0,127}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IMAGE_DATA = /^data:image\/(?:svg\+xml|png|jpeg|gif|webp)[;,]/i;

/** The resolver's answer if it is one the pictures can place, undefined if it gave none, and a TypeError for anything else: a mistake of the resolver's, not something to quietly draw differently. */
export function checkIcon(answer: unknown): IconRef | undefined {
  if (answer === undefined) return undefined;
  const object = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const { href, symbol } = object;
  if (typeof href === "string" && symbol === undefined) {
    const clean = cleanText(href);
    const ok = clean !== "" && clean.length <= MAX_HREF && !clean.startsWith("//") && (SCHEME.test(clean) ? /^https:\/\//i.test(clean) || IMAGE_DATA.test(clean) : true);
    if (ok) return { href: clean };
  }
  if (typeof symbol === "string" && href === undefined && SYMBOL.test(symbol)) return { symbol };
  throw new TypeError("an icon is { href } (an https: URL, a data:image/ URI or a path) or { symbol } (an SVG symbol id), or undefined");
}
