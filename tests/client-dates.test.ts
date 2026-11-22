// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A client component renders on the server (Railway: en-US, UTC) and again in the
// browser (the visitor's locale and zone). `toLocale*()` answers differently in
// the two, which React reports as a hydration mismatch (#418) and Cypress as a
// failed test. Dates in client components go through src/utils/format-date.ts.
function clientComponents(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => join(dir, file))
    // The licence header's `//` comments may come before the directive.
    .filter((file) => /^\s*(?:\/\/[^\n]*\n\s*)*["']use client["']/.test(readFileSync(file, "utf8")));
}

test("no client component formats a date with the host's locale or zone", () => {
  const files = clientComponents("src");
  assert.ok(files.length > 20, "found the client components");
  const offenders = files.filter((file) => /\.toLocale(Date|Time)?String\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});
