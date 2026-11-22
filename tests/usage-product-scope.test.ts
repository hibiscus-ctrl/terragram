// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every `usage_events` query and usage RPC in `src/` is scoped to terragram.
 *
 * The table and its functions are owned by `infraweaver-ui`'s migration and
 * shared with Infraweaver, which flushes its own rows to its own Stripe meter.
 * Rows carry a `product`, and the functions take a `p_product` that DEFAULTS to
 * 'infraweaver'. So a missing filter is silent in both directions: an unscoped
 * flush reports Infraweaver's overage on this meter and marks it reported, and an
 * omitted `p_product` records terragram's usage as Infraweaver's — billed on the
 * wrong meter, against the wrong allowance and cap. The query still answers
 * either way, which is why this reads the source.
 *
 * Run with `node --test tests`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { filesUnder } from "./helpers/source-files.ts";

const SRC = path.join(import.meta.dirname, "..", "src");

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

const files = filesUnder(SRC)
  .map((file) => ({ path: rel(file), source: readFileSync(file, "utf8") }))
  // The generated row types name every table and function; they query nothing.
  .filter((file) => file.path !== "libs/supabase/types.ts");

/** The shared SQL functions that sum, filter or write `usage_events` by product. */
const SCOPED_FUNCTIONS = [
  "managed_mint_reconciliation",
  "orgs_with_unreported_usage",
  "record_managed_usage",
  "usage_totals_since",
];

/** From `start` to the end of its statement — a query builder chain ends at `;`. */
function statementAt(source: string, start: number): string {
  const end = source.indexOf(";", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("usage_events product scope", () => {
  it("every usage_events read or insert filters or writes product = USAGE_PRODUCT", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const match of file.source.matchAll(/\.from\(\s*"usage_events"\s*\)/g)) {
        seen++;
        const chain = statementAt(file.source, match.index);
        // An update keyed on a row id cannot reach another product's rows.
        if (/\.update\(/.test(chain) && /\.eq\(\s*"id"/.test(chain)) continue;
        if (!/\.eq\(\s*"product",\s*USAGE_PRODUCT\s*\)|\bproduct:\s*USAGE_PRODUCT\b/.test(chain)) {
          offenders.push(file.path);
        }
      }
    }
    assert.ok(seen > 0, "no usage_events query found — has the scan stopped matching?");
    assert.deepEqual(offenders, [], "these usage_events queries are not scoped to terragram");
  });

  it("every call to a product-scoped SQL function passes p_product: USAGE_PRODUCT", () => {
    const offenders: string[] = [];
    let seen = 0;
    const call = new RegExp(`\\.rpc\\(\\s*"(${SCOPED_FUNCTIONS.join("|")})"`, "g");
    for (const file of files) {
      for (const match of file.source.matchAll(call)) {
        seen++;
        if (!/\bp_product:\s*USAGE_PRODUCT\b/.test(statementAt(file.source, match.index))) {
          offenders.push(`${file.path}: ${match[1]}`);
        }
      }
    }
    assert.ok(seen > 0, "no usage RPC found — has the scan stopped matching?");
    assert.deepEqual(offenders, [], "these calls fall back on the 'infraweaver' default");
  });
});
