// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * What `scripts/sandbox-gcp.sh` deletes and what it refuses to start beside. The sweep takes everything named like a run's
 * own and nothing else, in a project other people share; the preflight stops the run when a service account of the project
 * could be attached to what a plan creates and mint or widen access with it. Neither talks to a cloud here: the preflight
 * runs against a stand-in `gcloud` that prints a policy file.
 */

const scriptPath = new URL("../scripts/sandbox-gcp.sh", import.meta.url).pathname;
const script = readFileSync(scriptPath, "utf8");

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** The value a top-level `name=...` of the script is assigned. */
function assigned(name: string): string {
  const line = new RegExp(`^${name}=(.*)$`, "m").exec(script)?.[1];
  assert.ok(line, `${name} is assigned`);
  return line as string;
}

/** The text of one function of the script. */
function body(name: string): string {
  const start = script.indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, name);
  return script.slice(start, script.indexOf("\n}\n", start));
}

describe("the sandbox sweep's names", () => {
  // `run_re="${mark}([dpsf]|net-)[0-9a-f]{4}"`, `name_re="(^|[-/])${run_re}(-|\$)"`: written out here the way the shell expands them.
  const mark = "ih-sbx-tg-";
  const runRe = assigned("run_re").replace(/^"|"$/g, "").replace("${mark}", mark);
  const nameRe = new RegExp(assigned("name_re").replace(/^"|"$/g, "").replace("${run_re}", runRe).replace("\\$", "$"));
  const datasetRe = new RegExp(assigned("dataset_re").replace(/^'|'$/g, ""));

  it("matches what a run's plans name, by every shape the generator gives a name", () => {
    const prefix = `${mark}d1a2b`;
    for (const name of [
      `vm-${prefix}-virtual-machine`,
      `svc-${prefix}-containers`,
      `gke-${prefix}-kubernetes`,
      `allow-iap-ssh-${prefix}-vnet`,
      `projects/p/topics/topic-${prefix}-queue`,
      `projects/p/locations/europe-west2/functions/fn-${prefix}-functions`,
      `sandbox-project-data-${prefix}-object-storage-logs`,
      `${mark}net-1a2b`,
      `${prefix}-x`,
      prefix,
    ]) assert.ok(nameRe.test(name), name);
    assert.ok(datasetRe.test(`dw_${prefix.replaceAll("-", "_")}_data_warehouse`));
    assert.ok(runRe.includes(mark));
  });

  it("does not match something of someone else's that has the prefix in its name", () => {
    for (const name of [
      "ih-sbx-tg-notes",
      "prod-ih-sbx-tg",
      "ih-sbx-tg-",
      "xih-sbx-tg-d1a2b-x",
      "ih-sbx-tg-d1a2",
      "ih-sbx-tg-d1a2bc-x",
      "ih-sbx-tg-z1a2b-x",
      "ih-sbx-tg-D1A2B-x",
      "team-ih-sbx-tg-docs",
      "ih-sbx-tg-net-xyz1",
      "vm-ih-sbx-tgd1a2b-x",
    ]) assert.ok(!nameRe.test(name), name);
    for (const id of ["ih_sbx_tg_notes", "prod_ih_sbx_tg", "xih_sbx_tg_d1a2b", "dw_ih_sbx_tg_d1a2bc_x"]) assert.ok(!datasetRe.test(id), id);
  });

  it("is the only thing the sweep and its check list by: no substring of the mark", () => {
    for (const fn of ["sweep_all", "left_after_sweep"]) {
      const text = body(fn);
      assert.doesNotMatch(text, /\$mark|\$\{mark\}/, `${fn} filters by the mark alone`);
      assert.doesNotMatch(text, /grep -F|contains\(/, `${fn} matches a substring`);
      for (const filter of text.matchAll(/--filter ("(?:[^"\\]|\\.)*")/g)) {
        const expression = filter[1] as string;
        if (/type != SOA|state=ENABLED/.test(expression)) continue;
        assert.match(expression, /\$named|\$name_re|\$\{run_re\}/, `${fn}: ${expression}`);
      }
    }
    assert.doesNotMatch(script, /grep -F "\$1"/);
  });
});

describe("the sandbox preflight", () => {
  const EMAIL = "sandbox-deployer@sandbox-project.iam.gserviceaccount.com";

  /** Runs `preflight` against a policy, with a stand-in gcloud and a credentials file that says which account signs in. */
  function run(policy: unknown, options: { raw?: string; signedInAs?: string | null; gcloudFails?: boolean } = {}): { code: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-preflight-"));
    made.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "policy.json"), options.raw ?? JSON.stringify(policy));
    writeFileSync(join(bin, "gcloud"), `#!/usr/bin/env bash\n${options.gcloudFails ? "exit 1" : `[ "$1 $2" = "projects get-iam-policy" ] && cat "${join(dir, "policy.json")}"`}\n`);
    chmodSync(join(bin, "gcloud"), 0o755);
    const credentials = join(dir, "credentials.json");
    const signedInAs = options.signedInAs === undefined ? EMAIL : options.signedInAs;
    writeFileSync(
      credentials,
      JSON.stringify({ type: "external_account", ...(signedInAs === null ? {} : { service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${signedInAs}:generateAccessToken` }) }),
    );
    const result = spawnSync("bash", [scriptPath, "preflight"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: dir,
        SANDBOX_DIR: join(dir, "work"),
        GOOGLE_PROJECT_ID: "sandbox-project",
        GOOGLE_APPLICATION_CREDENTIALS: credentials,
      },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  const grant = (role: string, ...members: string[]) => ({ bindings: [{ role, members }] });

  it("passes a project whose service accounts hold only what they need", () => {
    const policy = {
      bindings: [
        { role: "roles/logging.logWriter", members: [`serviceAccount:other@sandbox-project.iam.gserviceaccount.com`] },
        { role: "roles/editor", members: ["user:someone@example.com", "group:team@example.com"] },
        { role: "roles/iam.serviceAccountUser", members: [`serviceAccount:${EMAIL}`, "user:someone@example.com"] },
        { role: "roles/iam.serviceAccountTokenCreator", members: ["group:admins@example.com"] },
      ],
    };
    const { code, out } = run(policy);
    assert.equal(code, 0, out);
    assert.match(out, /No service account holds/);
  });

  it("refuses Editor and Owner on a service account, as it always has", () => {
    for (const role of ["roles/editor", "roles/owner"]) {
      const { code, out } = run(grant(role, "serviceAccount:ci@sandbox-project.iam.gserviceaccount.com"));
      assert.equal(code, 1, out);
      assert.match(out, new RegExp(`::error::.*${role}: 1`));
    }
  });

  it("refuses each role that lets a service account act as, mint credentials for or widen access to others", () => {
    for (const role of [
      "roles/iam.serviceAccountTokenCreator",
      "roles/iam.serviceAccountUser",
      "roles/resourcemanager.projectIamAdmin",
      "roles/iam.securityAdmin",
      "roles/iam.roleAdmin",
      "roles/iam.serviceAccountKeyAdmin",
    ]) {
      for (const member of ["serviceAccount:ci@sandbox-project.iam.gserviceaccount.com", "principal://iam.googleapis.com/projects/-/serviceAccounts/ci@sandbox-project.iam.gserviceaccount.com"]) {
        const { code, out } = run(grant(role, member));
        assert.equal(code, 1, `${role} for ${member}: ${out}`);
        assert.match(out, new RegExp(`::error::.*${role.replaceAll(".", "\\.")}: 1`), out);
        assert.doesNotMatch(out, /ci@/, "an account's name is never printed");
      }
    }
  });

  it("lets the account the job signs in as keep Service Account User, and nothing else of the risky roles", () => {
    assert.equal(run(grant("roles/iam.serviceAccountUser", `serviceAccount:${EMAIL}`)).code, 0);
    assert.equal(run(grant("roles/iam.serviceAccountUser", `serviceAccount:${EMAIL.toUpperCase()}`)).code, 0);
    assert.equal(run(grant("roles/iam.serviceAccountUser", `serviceAccount:${EMAIL}`), { signedInAs: null }).code, 1, "an account that cannot be read exempts nothing");
    assert.equal(run(grant("roles/iam.serviceAccountUser", `serviceAccount:${EMAIL}`), { signedInAs: "another@sandbox-project.iam.gserviceaccount.com" }).code, 1);
    for (const role of ["roles/editor", "roles/owner", "roles/iam.serviceAccountTokenCreator", "roles/resourcemanager.projectIamAdmin", "roles/iam.securityAdmin", "roles/iam.roleAdmin", "roles/iam.serviceAccountKeyAdmin"]) {
      assert.equal(run(grant(role, `serviceAccount:${EMAIL}`)).code, 1, role);
    }
  });

  it("counts every grant, and fails closed on a policy it cannot read", () => {
    const two = run({
      bindings: [
        { role: "roles/iam.securityAdmin", members: ["serviceAccount:a@p.iam.gserviceaccount.com", "serviceAccount:b@p.iam.gserviceaccount.com"] },
        { role: "roles/owner", members: ["serviceAccount:c@p.iam.gserviceaccount.com"] },
      ],
    });
    assert.equal(two.code, 1);
    assert.match(two.out, /roles\/iam\.securityAdmin: 2/);
    assert.match(two.out, /roles\/owner: 1/);
    for (const options of [{ gcloudFails: true }, { raw: "not json" }, { raw: "[]" }, { raw: "" }]) {
      const { code, out } = run({}, options);
      assert.equal(code, 1, JSON.stringify(options));
      assert.match(out, /::error::/);
    }
  });
});
