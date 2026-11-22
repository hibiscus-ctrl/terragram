/**
 * The boot-time environment report (`src/config/env.ts`).
 *
 * The case worth the module is `partial`: a feature with SOME of its variables set
 * boots clean, serves every page, and fails only at the one moment it is used.
 * Values below are synthetic placeholders, never issued credentials.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkEnv, FEATURES, featureConfigured, REQUIRED } from "../src/config/env.ts";

/** Everything REQUIRED, so a case can be about exactly the feature it names. */
const BASE: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  NEXT_PUBLIC_SITE_URL: "https://example.test",
};

const withEnv = (over: Record<string, string | undefined> = {}) => checkEnv({ ...BASE, ...over });

describe("environment report — required variables", () => {
  it("is ok on a bare but complete environment, with every feature off", () => {
    const report = withEnv();
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.incomplete, {});
    assert.equal(report.ok, true);
    assert.ok(Object.values(report.features).every((s) => s === "off"));
  });

  it("names each missing required variable", () => {
    const report = checkEnv({});
    assert.deepEqual(report.missing.sort(), REQUIRED.map((v) => v.name).sort());
    assert.equal(report.ok, false);
  });

  it("accepts the legacy alias of a renamed variable", () => {
    const report = withEnv({
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "legacy-anon",
    });
    assert.deepEqual(report.missing, []);
  });

  it("treats an empty or whitespace value as absent", () => {
    for (const value of ["", "   "]) {
      assert.deepEqual(withEnv({ NEXT_PUBLIC_SITE_URL: value }).missing, ["NEXT_PUBLIC_SITE_URL"]);
    }
  });
});

describe("environment report — feature sets", () => {
  it("reports a fully configured feature as on", () => {
    const report = withEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
    assert.equal(report.features.billing, "on");
    assert.equal(report.ok, true);
  });

  it("reports a half-configured feature as partial and names what it lacks", () => {
    // A proxy URL with no signing secret: managed runs would mint nothing.
    const report = withEnv({ TERRAGRAM_MODEL_PROXY_URL: "https://proxy.example.test" });
    assert.equal(report.features.managedModels, "partial");
    assert.deepEqual(report.incomplete.managedModels, ["TERRAGRAM_MODEL_PROXY_SECRET"]);
    assert.equal(report.ok, false);
  });

  it("flags a Git host whose tokens could not be sealed", () => {
    const report = withEnv({ GITHUB_APP_CLIENT_ID: "Iv1.x", GITHUB_APP_CLIENT_SECRET: "y" });
    assert.equal(report.features.gitGithub, "partial");
    assert.deepEqual(report.incomplete.gitGithub, ["GIT_TOKEN_ENCRYPTION_KEY"]);
  });

  it("does not turn a feature on through a variable it only shares", () => {
    // The encryption key alone is not a request to enable either Git host.
    const report = withEnv({
      GITHUB_APP_CLIENT_ID: "Iv1.x",
      GITHUB_APP_CLIENT_SECRET: "y",
      GIT_TOKEN_ENCRYPTION_KEY: "k",
    });
    assert.equal(report.features.gitGithub, "on");
    assert.equal(report.features.gitGitlab, "off");
    assert.equal(report.ok, true);
  });

  it("reports invite email on only with both SES keys, and partial with one", () => {
    const both = withEnv({ SES_ACCESS_KEY_ID: "AKIA_PLACEHOLDER", SES_SECRET_ACCESS_KEY: "s" });
    assert.equal(both.features.email, "on");
    const one = withEnv({ SES_ACCESS_KEY_ID: "AKIA_PLACEHOLDER" });
    assert.equal(one.features.email, "partial");
    assert.deepEqual(one.incomplete.email, ["SES_SECRET_ACCESS_KEY"]);
  });

  it("lists every declared feature in the report", () => {
    assert.deepEqual(Object.keys(withEnv().features).sort(), FEATURES.map((f) => f.key).sort());
  });
});

describe("featureConfigured", () => {
  it("is true only when every variable of the feature is set", () => {
    assert.equal(featureConfigured("email", { SES_ACCESS_KEY_ID: "a", SES_SECRET_ACCESS_KEY: "b" }), true);
    assert.equal(featureConfigured("email", { SES_ACCESS_KEY_ID: "a", SES_SECRET_ACCESS_KEY: " " }), false);
    assert.equal(featureConfigured("email", {}), false);
  });

  it("counts the variables a feature needs but does not own", () => {
    const github = { GITHUB_APP_CLIENT_ID: "Iv1.x", GITHUB_APP_CLIENT_SECRET: "y" };
    assert.equal(featureConfigured("gitGithub", github), false);
    assert.equal(featureConfigured("gitGithub", { ...github, GIT_TOKEN_ENCRYPTION_KEY: "k" }), true);
  });

  it("is false for an undeclared feature", () => {
    assert.equal(featureConfigured("no-such-feature", { SES_ACCESS_KEY_ID: "a" }), false);
  });
});

describe("environment report — length floors", () => {
  it("flags a JOBS_DRAIN_SECRET under the 16 chars the runtime accepts", () => {
    // `requireJobsSecret` refuses a shorter one at request time, answering 401 to
    // its own cron and saying why only in the server log. Set-but-too-short is
    // otherwise indistinguishable from a wrong secret at the call site.
    const report = withEnv({ JOBS_DRAIN_SECRET: "tooshort" });
    assert.deepEqual(report.weak, ["JOBS_DRAIN_SECRET (min 16)"]);
    assert.equal(report.ok, false);
    // Still "on": it is present, just refused. The `weak` line is the finding.
    assert.equal(report.features.jobsDrain, "on");
  });

  it("accepts one at the floor, and says nothing about an unset one", () => {
    const atFloor = withEnv({ JOBS_DRAIN_SECRET: "x".repeat(16) });
    assert.deepEqual(atFloor.weak, []);
    assert.equal(atFloor.ok, true);

    const unset = withEnv();
    assert.deepEqual(unset.weak, []);
    assert.equal(unset.features.jobsDrain, "off");
  });
});
