// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response-shape assertions. Status codes alone under-specify a contract: a
 * handler can keep its status while dropping a field its caller reads, so the
 * suites assert the KEY SET of success bodies and the exact error envelope of
 * failures.
 */
import assert from "node:assert/strict";

import type { Response } from "supertest";

/** The body's key set is EXACTLY `keys` — no missing, no extras. */
export function assertExactKeys(
  body: unknown,
  keys: readonly string[],
  label = "body",
): asserts body is Record<string, unknown> {
  assert.ok(body && typeof body === "object", `${label} is an object`);
  assert.deepEqual(Object.keys(body as object).sort(), [...keys].sort(), `${label} key set`);
}

/** Standard apiError envelope: `{error}` (plus only the listed extras). */
export function assertApiError(
  res: Response,
  status: number,
  error: string | RegExp,
  extraKeys: readonly string[] = [],
): void {
  assert.equal(res.status, status, `status (body: ${JSON.stringify(res.body)})`);
  assertExactKeys(res.body, ["error", ...extraKeys], "error body");
  if (typeof error === "string") assert.equal(res.body.error, error);
  else assert.match(String(res.body.error), error);
}

/** The shared rate-limit envelope every 429 in the app must carry. */
export function assertRateLimited(res: Response): void {
  assert.equal(res.status, 429);
  assertExactKeys(res.body, ["error", "message", "retryAfterMs"], "429 body");
  assert.equal(res.body.error, "rate_limited");
  assert.equal(typeof res.body.message, "string");
  assert.ok(
    typeof res.body.retryAfterMs === "number" && res.body.retryAfterMs >= 0,
    "retryAfterMs is a non-negative number",
  );
}

/** The response is a redirect whose target stays on `origin`; returns the target. */
export function assertSameOriginRedirect(res: Response, origin: string, label: string): URL {
  assert.ok([302, 303, 307, 308].includes(res.status), `${label}: expected redirect, got ${res.status}`);
  const location = res.headers.location;
  assert.ok(location, `${label}: has Location`);
  const target = new URL(String(location), origin);
  assert.equal(target.origin, origin, `${label}: stays on-site (${location})`);
  return target;
}
