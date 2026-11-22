/**
 * The gate in front of the scheduler-facing job routes (`/api/jobs/*`).
 *
 * The properties pinned: an unconfigured server answers exactly as a wrong secret
 * does, the flood guard runs before the compare but after the configuration
 * check, and an empty header never matches. The HTTP half is
 * `tests/api/jobs.test.ts` and `tests/api-unconfigured/`. Secrets below are
 * synthetic placeholders.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JOBS_SECRET_MIN_LENGTH, makeRequireJobsSecret } from "../src/features/api/jobs-secret-core.ts";

const SECRET = "test-jobs-secret-0000000001";
const OPTS = { label: "jobs/test", disables: "the test job", key: "jobs-test", limit: 60 };

type Refusal = { status: number; error: string };

function harness(secret: string | undefined, limited: Refusal | null = null) {
  const limiterKeys: string[] = [];
  const warnings: string[] = [];
  const gate = makeRequireJobsSecret<Refusal>({
    secret: () => secret,
    clientIp: () => "203.0.113.7",
    rateLimited: async (key) => {
      limiterKeys.push(key);
      return limited;
    },
    unauthorized: () => ({ status: 401, error: "unauthorized" }),
    warn: (message) => warnings.push(message),
  });
  return { gate, limiterKeys, warnings };
}

const request = (header?: string) =>
  new Request("https://terragram.test/api/jobs/test", {
    method: "POST",
    headers: header === undefined ? {} : { "x-jobs-secret": header },
  });

describe("requireJobsSecret", () => {
  it("passes the scheduler's exact secret", async () => {
    const { gate, limiterKeys } = harness(SECRET);
    assert.equal(await gate(request(SECRET), OPTS), null);
    assert.deepEqual(limiterKeys, ["jobs-test:203.0.113.7"]);
  });

  it("refuses a wrong or missing secret with the same 401", async () => {
    const { gate } = harness(SECRET);
    for (const header of [undefined, "", `${SECRET}x`, SECRET.slice(0, -1)]) {
      assert.deepEqual(await gate(request(header), OPTS), { status: 401, error: "unauthorized" }, String(header));
    }
  });

  it("answers an unconfigured server with that same 401, never a 501", async () => {
    // With nothing to authenticate against every caller is unauthenticated; a
    // distinct status would tell an anonymous caller how the server is set up.
    for (const secret of [undefined, ""]) {
      const { gate, limiterKeys, warnings } = harness(secret);
      for (const header of [undefined, "", "x".repeat(32)]) {
        assert.deepEqual(await gate(request(header), OPTS), { status: 401, error: "unauthorized" });
      }
      assert.deepEqual(limiterKeys, [], "an unconfigured refusal must not spend a limiter round trip");
      assert.match(warnings[0] ?? "", /JOBS_DRAIN_SECRET/, "the operator still learns why, from the log");
    }
  });

  it("refuses a secret shorter than the floor, even when the caller matches it", async () => {
    const short = "s".repeat(JOBS_SECRET_MIN_LENGTH - 1);
    const { gate } = harness(short);
    assert.deepEqual(await gate(request(short), OPTS), { status: 401, error: "unauthorized" });

    const atFloor = "s".repeat(JOBS_SECRET_MIN_LENGTH);
    assert.equal(await harness(atFloor).gate(request(atFloor), OPTS), null);
  });

  it("returns the limiter's refusal before comparing, so a guesser burns its budget", async () => {
    const limited = { status: 429, error: "rate_limited" };
    const { gate } = harness(SECRET, limited);
    // Even the CORRECT secret is refused once the window is spent: the compare never ran.
    assert.equal(await gate(request(SECRET), OPTS), limited);
  });
});
