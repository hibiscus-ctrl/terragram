// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every route handler must answer a throw with a shaped response, not a bare
 * framework 500.
 *
 * `error.tsx` does NOT cover route handlers: Next re-throws everything but
 * `redirect()` / `notFound()` past any React boundary, so an uncaught throw is an
 * HTML 500 to a client that parses `{ error }` — or, on a link-followed route, an
 * error page in the middle of signing in. The handlers cannot be imported under
 * `node --test` (`next/server` has no condition plain Node resolves), so this is a
 * source-level check: adding a route makes it FAIL until the route is wrapped or
 * exempted here with a reason.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../src/app/", import.meta.url));

const routes = (readdirSync(appDir, { recursive: true }) as string[])
  .filter((p) => p.endsWith(`${sep}route.ts`) || p === "route.ts")
  .map((p) => ({
    id: relative(appDir, join(appDir, p)).split(sep).slice(0, -1).join("/"),
    source: readFileSync(join(appDir, p), "utf8"),
  }));

/** Routes served WITHOUT a boundary, each for a stated reason. Keep it short. */
const NO_ERROR_BOUNDARY: Record<string, string> = {
  "api/health":
    "Liveness probe. Synchronous and dependency-free — nothing in it can throw, and if it ever did a 500 is the right signal to the platform.",
  "api/health/ready":
    "Readiness probe. Catches its one dependency read itself and reports a boolean; a non-200 is the gating signal, so a shaped error body would defeat it.",
};

const BOUNDARY = /\bwithRouteErrors\(|\bwithRedirectErrors\(/;

describe("route error posture", () => {
  it("finds the routes it is checking", () => {
    assert.ok(routes.length >= 8, `only ${routes.length} routes found under src/app`);
  });

  for (const route of routes) {
    it(`/${route.id} cannot answer with a bare framework 500`, () => {
      if (route.id in NO_ERROR_BOUNDARY) return;
      assert.match(
        route.source,
        BOUNDARY,
        `/${route.id} has no error boundary. Wrap its handler in withRouteErrors (or withRedirectErrors for a link-followed route), or exempt it in NO_ERROR_BOUNDARY with a reason.`,
      );
      assert.doesNotMatch(
        route.source,
        /export async function (GET|POST|PUT|PATCH|DELETE)\b/,
        `/${route.id} exports a bare handler beside the wrapped one`,
      );
    });
  }

  it("every exemption still names a real route", () => {
    for (const id of Object.keys(NO_ERROR_BOUNDARY)) {
      assert.ok(routes.some((r) => r.id === id), `NO_ERROR_BOUNDARY names "${id}", which is not a route`);
    }
  });
});
