// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an unhandled route failure records and what it discloses.
 *
 * The two halves are a pair: the response must carry nothing derived from the
 * thrown value, and the log must carry enough to find the request — joined by an
 * id that is meaningless on its own. `route-errors.ts` (the `unstable_rethrow` +
 * `NextResponse` adapter) cannot be loaded under `node --test`; the decisions it
 * delegates to live in `error-capture.ts` so they can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { registerTokenPrefix } from "@infraweaver-io/core/redact";

import {
  buildIncident,
  internalErrorBody,
  requestLabel,
} from "../src/features/api/error-capture.ts";

// `src/libs/log.ts` registers this at import, and route-errors.ts imports it.
registerTokenPrefix("tmpx_");

let n = 0;
const ids = () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`;

describe("internalErrorBody — what the caller is allowed to see", () => {
  it("carries exactly three fields, none derived from the error", () => {
    const body = internalErrorBody("abc123def456");
    assert.deepEqual(Object.keys(body).sort(), ["error", "incident_id", "message"]);
    assert.equal(body.error, "internal_error");
    assert.equal(body.incident_id, "abc123def456");
  });

  it("does not name the failing subsystem", () => {
    assert.doesNotMatch(JSON.stringify(internalErrorBody("x")), /database|supabase|postgres|stripe/i);
  });
});

describe("buildIncident — what reaches the log", () => {
  it("returns a 12-hex id that is also stamped into the record", () => {
    const { incidentId, record } = buildIncident(new Error("boom"), "L", ids);
    assert.match(incidentId, /^[0-9a-f]{12}$/);
    assert.equal(record.incident_id, incidentId);
    assert.equal(record.event, "route_error");
  });

  it("keeps name, message, label and stack so the failure is findable", () => {
    const { record } = buildIncident(new TypeError('relation "orgs" does not exist'), "POST /api/x", ids);
    assert.equal(record.name, "TypeError");
    assert.equal(record.message, 'relation "orgs" does not exist');
    assert.equal(record.label, "POST /api/x");
    assert.ok(record.stack?.includes("TypeError"));
  });

  it("describes a thrown non-Error by its message field", () => {
    const { record } = buildIncident({ message: "permission denied", code: "42501" }, "L", ids);
    assert.equal(record.name, "NonError");
    assert.match(record.message, /permission denied/);
  });

  it("redacts a token in the message, the stack and the cause", () => {
    const err = new Error("gateway said Bearer tmpx_abcdef0123456789.sig", {
      cause: new Error("retry with tmpx_fedcba9876543210.sig"),
    });
    const { record } = buildIncident(err, "L", ids);
    const text = JSON.stringify(record);
    assert.doesNotMatch(text, /tmpx_abcdef0123456789/);
    assert.doesNotMatch(text, /tmpx_fedcba9876543210/);
    assert.ok(record.cause, "the cause is still recorded");
  });
});

describe("requestLabel", () => {
  it("names the route by method and concrete path, without the query", () => {
    const label = requestLabel(new Request("https://example.test/api/webhooks?token=abc", { method: "POST" }));
    assert.equal(label, "POST /api/webhooks");
  });

  it("falls back for something that is not a Request", () => {
    assert.equal(requestLabel(undefined), "unknown route");
  });
});
