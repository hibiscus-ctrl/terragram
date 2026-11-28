// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { assembleModel } from "terragram-engine/engine";
import { emitTerraform } from "terragram-engine/terraform";
import { GCP_PLANS } from "../scripts/emit-plans.ts";
import { adaptForSandbox } from "../scripts/lib/sandbox-gcp.ts";
import { ALLOWED_PROVIDERS, PINNED_SOURCES, PLAN_IDS, PlanRejected, validatePlans, validateSource } from "../scripts/sandbox-gcp-validate.mjs";

/**
 * The gate between the sandbox workflow's two jobs: the plans the first job wrote are checked, by the job that
 * can get a token, before Terraform runs on them (`scripts/sandbox-gcp-validate.mjs`). These hold that what the
 * generator writes today passes, and that each thing a compromised dependency could plant instead does not.
 */

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** The four plans as the workflow writes them, in a new directory. */
function plans(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-validate-"));
  made.push(root);
  for (const plan of GCP_PLANS) {
    const generated = emitTerraform(assembleModel(plan.kinds, undefined, true).model, "gcp", "terraform").files;
    for (const file of adaptForSandbox(plan.id, generated)) {
      const path = join(root, plan.id, file.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
  }
  return root;
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const write = (root: string, rel: string, content: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
/** Appends a block to a plan's main.tf and expects the plans to be refused for `why`. */
const refusesAppended = (block: string, why: RegExp) => {
  const root = plans();
  write(root, "gcp-site/main.tf", `${read(root, "gcp-site/main.tf")}\n${block}\n`);
  assert.throws(() => validatePlans(root), (e) => e instanceof PlanRejected && why.test(e.message), block);
};
const refusesWhole = (mutate: (root: string) => void, why: RegExp) => {
  const root = plans();
  mutate(root);
  assert.throws(() => validatePlans(root), (e) => e instanceof PlanRejected && why.test(e.message));
};
const refusesSource = (text: string, why: RegExp) => assert.throws(() => validateSource(text, "x.tf"), (e) => e instanceof PlanRejected && why.test(e.message), text);

describe("the sandbox's check of the plans", () => {
  it("passes the four plans as the generator writes them, and gives a digest that follows their content", () => {
    const root = plans();
    const first = validatePlans(root);
    assert.equal(first.plans, 4);
    assert.ok(first.files >= 12, "the plans' files were read");
    assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(validatePlans(root).digest, first.digest);
    write(root, "gcp-site/main.tf", `${read(root, "gcp-site/main.tf")}# a comment\n`);
    assert.notEqual(validatePlans(root).digest, first.digest);
  });

  it("names the same plans, and the same providers, as the generator", () => {
    assert.deepEqual([...PLAN_IDS].sort(), GCP_PLANS.map((p) => p.id).sort());
    const root = plans();
    const wanted = new Set<string>();
    for (const id of PLAN_IDS) for (const m of read(root, `${id}/main.tf`).matchAll(/^\s+([a-z-]+) = \{\n\s+source\s+= "([^"]+)"\n\s+version\s+= "([^"]+)"/gm)) {
      assert.deepEqual(ALLOWED_PROVIDERS[m[1] as keyof typeof ALLOWED_PROVIDERS], { source: m[2], version: m[3] }, `${id}: ${m[1]}`);
      wanted.add(m[1] as string);
    }
    assert.deepEqual([...wanted].sort(), Object.keys(ALLOWED_PROVIDERS).sort());
    for (const path of Object.keys(PINNED_SOURCES)) assert.ok(read(root, path).length > 0, path);
  });

  it("locks, for each root Terraform runs in, the providers it requires and no others, to versions its constraints allow", () => {
    const root = plans();
    const roots = new Map<string, string>(PLAN_IDS.map((id) => [id, read(root, `${id}/main.tf`)]));
    roots.set("network", readFileSync(new URL("../scripts/sandbox-gcp-network/main.tf", import.meta.url), "utf8"));
    assert.equal(roots.size, 5);
    for (const [id, main] of roots) {
      const lock = readFileSync(new URL(`../scripts/sandbox-gcp-locks/${id}.terraform.lock.hcl`, import.meta.url), "utf8");
      const required = [...main.matchAll(/^\s+([a-z-]+) = \{\n\s+source\s+= "hashicorp\/[a-z-]+"/gm)].map((m) => m[1] as string);
      const locked = [...lock.matchAll(/provider "registry\.terraform\.io\/hashicorp\/([a-z-]+)" \{\n\s+version\s+= "([^"]+)"\n\s+constraints = "([^"]+)"\n\s+hashes = \[\n([^\]]*)\]/g)];
      assert.ok(required.length >= 1, id);
      assert.deepEqual(locked.map((m) => m[1]).sort(), [...required].sort(), `${id}: the lock names what the root requires`);
      for (const [, name, version, constraint, hashes] of locked) {
        const provider = ALLOWED_PROVIDERS[name as keyof typeof ALLOWED_PROVIDERS];
        assert.equal(constraint, provider.version, `${id}: ${name}`);
        const [major, minor] = (/^~> (\d+)\.(\d+)$/.exec(provider.version) ?? []).slice(1).map(Number);
        const [lockedMajor, lockedMinor] = (version as string).split(".").map(Number);
        assert.ok(lockedMajor === major && (lockedMinor ?? 0) >= (minor ?? 0), `${id}: ${name} ${version} satisfies ${provider.version}`);
        assert.match(hashes ?? "", /"h1:[A-Za-z0-9+/=]+"/, `${id}: ${name} has a h1 hash`);
        assert.match(hashes ?? "", /"zh:[0-9a-f]{64}"/, `${id}: ${name} has zh hashes`);
      }
    }
  });

  it("passes the network root the workflow applies with the plans", () => {
    const text = readFileSync(new URL("../scripts/sandbox-gcp-network/main.tf", import.meta.url), "utf8");
    validateSource(text, "network/main.tf");
  });

  it("refuses code that runs on the runner", () => {
    refusesAppended('data "external" "x" {\n  program = ["sh", "-c", "id"]\n}', /external is not of an allowed provider/);
    refusesAppended('resource "null_resource" "x" {\n}', /null_resource/);
    refusesAppended('resource "terraform_data" "x" {\n  provisioner "local-exec" {\n    command = "id"\n  }\n}', /provisioner/);
    refusesAppended('resource "google_storage_bucket" "x" {\n  name = "x"\n  provisioner "remote-exec" {\n  }\n}', /provisioner/);
    refusesAppended('locals {\n  x = "local-exec"\n}', /local-exec/);
    refusesAppended('data "terraform_remote_state" "x" {\n}', /terraform_remote_state/);
    refusesAppended('resource "local_file" "x" {\n}', /local_file/);
    refusesAppended('data "archive_file" "x" {\n  type        = "zip"\n  source_dir  = "/home/runner"\n  output_path = "${path.module}/.terraform/x.zip"\n}', /archive_file may only zip/);
    refusesAppended('data "archive_file" "x" {\n  type        = "zip"\n  source_dir  = "${path.module}/../.."\n  output_path = "${path.module}/.terraform/x.zip"\n}', /archive_file may only zip/);
    refusesAppended('data "archive_file" "x" {\n  type        = "zip"\n  source_file = "/etc/passwd"\n  output_path = "${path.module}/.terraform/x.zip"\n}', /archive_file may only zip/);
    refusesAppended('data "archive_file" "x" {\n  type        = "zip"\n  source_dir  = "${path.module}/src/a"\n  output_path = "/tmp/x.zip"\n}', /archive_file may only zip/);
  });

  it("refuses a file that is read, and a provider's own function", () => {
    refusesAppended('locals {\n  x = file("/etc/passwd")\n}', /function file/);
    refusesAppended('locals {\n  x = "${templatefile("a", {})}"\n}', /function templatefile/);
    refusesAppended('locals {\n  x = "a ${ { b = filebase64("c") } } d"\n}', /function filebase64/);
    refusesAppended("locals {\n  x = provider::external::run()\n}", /function of a provider/);
    refusesAppended('locals {\n  x = fileset(path.module, "*")\n}', /function fileset/);
  });

  it("refuses a backend, a cloud block, and anything else in the terraform block", () => {
    const root = plans();
    const main = read(root, "gcp-site/main.tf");
    write(root, "gcp-site/main.tf", main.replace("terraform {\n", 'terraform {\n  backend "http" {\n    address = "https://example.com"\n  }\n'));
    assert.throws(() => validatePlans(root), /terraform may hold only required_providers, not backend/);
    write(root, "gcp-site/main.tf", main.replace("terraform {\n", 'terraform {\n  cloud {\n    organization = "x"\n  }\n'));
    assert.throws(() => validatePlans(root), /not cloud/);
    write(root, "gcp-site/main.tf", main.replace("terraform {\n", "terraform {\n  experiments = [x]\n"));
    assert.throws(() => validatePlans(root), /terraform may set only a required_version/);
    write(root, "gcp-site/main.tf", main.replace("terraform {\n", "terraform {\n  provider_meta \"google\" {\n  }\n"));
    assert.throws(() => validatePlans(root), /not provider_meta/);
  });

  it("refuses modules, and the other blocks the generator does not write", () => {
    refusesAppended('module "x" {\n  source = "git::https://example.com/x.git"\n}', /module block is not allowed/);
    refusesAppended('module "x" {\n  source = "./local"\n}', /module block is not allowed/);
    refusesAppended('moved {\n  from = a.b\n  to   = a.c\n}', /moved block/);
    refusesAppended('import {\n  to = a.b\n  id = "x"\n}', /import block/);
    refusesAppended('removed {\n  from = a.b\n}', /removed block/);
    refusesAppended('check "x" {\n}', /check block/);
    refusesAppended("x = 1", /attribute outside a block/);
    refusesAppended('resource "google_a" {\n}', /takes 2 labels/);
  });

  it("allows only the providers, sources and versions it lists, written exactly", () => {
    const bad = (from: string, to: string, why: RegExp) => {
      const root = plans();
      const main = read(root, "gcp-site/main.tf");
      assert.ok(main.includes(from), from);
      write(root, "gcp-site/main.tf", main.replace(from, to));
      assert.throws(() => validatePlans(root), why, to);
    };
    bad('source  = "hashicorp/google"', 'source  = "evil/google"', /provider google must be exactly/);
    bad('source  = "hashicorp/google"', 'source  = "registry.terraform.io/hashicorp/google"', /provider google must be exactly/);
    bad('version = "~> 8.12"', 'version = ">= 8.12"', /provider google must be exactly/);
    bad('version = "~> 8.12"', 'version = "~> 8.12, != 8.12.1"', /provider google must be exactly/);
    bad('version = "~> 8.12"', 'version = "~> 8.12"\n      configuration_aliases = [google.x]', /object of strings/);
    bad("google = {", "google = {\n      extra = \"x\"", /provider google must be exactly/);
    bad("google = {", 'http = {\n      source  = "hashicorp/http"\n      version = "~> 3.0"\n    }\n    google = {', /provider http is not allowed/);
    bad("google = {", 'external = {\n      source  = "hashicorp/external"\n      version = "~> 2.3"\n    }\n    google = {', /provider external is not allowed/);
    bad("google = {", 'google = "~> 8.12"\n    google2 = {', /object of strings/);
    bad('provider "google" {\n', 'provider "google" {\n  credentials = "x"\n', /a provider may set only/);
    bad('provider "google" {\n', 'provider "google" {\n  impersonate_service_account = "x@y.z"\n', /a provider may set only/);
    refusesAppended('provider "http" {\n}', /provider http is not configured here/);
    refusesAppended('provider "archive" {\n}', /provider archive is not configured here/);
  });

  it("refuses files that are not plain Terraform, and names that are not plain", () => {
    refusesWhole((r) => write(r, "gcp-site/.terraform.lock.hcl", "# planted\n"), /name is not a plain one/);
    refusesWhole((r) => write(r, "gcp-site/.terraformrc", 'provider_installation {\n}\n'), /name is not a plain one/);
    refusesWhole((r) => write(r, "gcp-site/.terraform/providers/x", "x"), /name is not a plain one/);
    refusesWhole((r) => write(r, "gcp-site/terraform.d/plugins/x", "x"), /not a \*\.tf|a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/extra.tf.json", "{}"), /a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/run.sh", "id"), /a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/terraform.tfstate", "{}"), /a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/override.tf", ""), /a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/x_override.tf", ""), /a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/a b.tf", ""), /name is not a plain one/);
    refusesWhole((r) => write(r, "gcp-site/a\\b.tf", ""), /name is not a plain one/);
    refusesWhole((r) => write(r, "gcp-site/ä.tf", ""), /name is not a plain one/);
    refusesWhole((r) => write(r, "gcp-site/src/x/index.js", "require('child_process')"), /a file that is not/);
    refusesWhole((r) => write(r, "gcp-site/a/b/c/d/e/f.tf", ""), /too deep/);
    refusesWhole((r) => write(r, "gcp-site/big.tf", `# ${"x".repeat(300 * 1024)}\n`), /over the size limit/);
    refusesWhole((r) => write(r, "gcp-site/utf16.tf", "\u0000x"), /control or direction-changing/);
    refusesWhole((r) => write(r, "gcp-site/bidi.tf", "# \u202e\n"), /control or direction-changing/);
  });

  it("refuses a placeholder source that is not the generator's", () => {
    refusesWhole((r) => write(r, "gcp-serverless/src/functions/index.js", `${read(r, "gcp-serverless/src/functions/index.js")}require("child_process");\n`), /not the generator's/);
    refusesWhole((r) => write(r, "gcp-data/src/app-service/package.json", '{"scripts":{"postinstall":"id"}}'), /not the generator's/);
  });

  it("refuses links, and entries that are not the four plans", () => {
    refusesWhole((r) => symlinkSync("/etc/passwd", join(r, "gcp-site", "main2.tf")), /not a regular file/);
    refusesWhole((r) => symlinkSync("/etc", join(r, "gcp-site", "etc")), /not a regular file/);
    refusesWhole((r) => {
      rmSync(join(r, "gcp-data"), { recursive: true });
      symlinkSync(join(r, "gcp-site"), join(r, "gcp-data"));
    }, /not a directory/);
    refusesWhole((r) => write(r, "extra/main.tf", ""), /expected exactly/);
    refusesWhole((r) => write(r, "network/main.tf", ""), /expected exactly/);
    refusesWhole((r) => rmSync(join(r, "gcp-data"), { recursive: true }), /expected exactly/);
    refusesWhole((r) => writeFileSync(join(r, "stray.tf"), ""), /expected exactly/);
    assert.throws(() => validatePlans(join(tmpdir(), "no-such-plans-dir")), /no such directory/);
    const file = join(plans(), "gcp-site", "main.tf");
    assert.throws(() => validatePlans(file), /not a directory/);
  });

  it("refuses what it cannot read, rather than skipping it", () => {
    refusesSource('resource "google_x" "y" {\n  a = "never closed\n}\n', /runs over a line/);
    refusesSource('resource "google_x" "y" {\n  a = "never closed', /never closed/);
    refusesSource('resource "google_x" "y" {\n  a = 1\n', /block is never closed/);
    refusesSource('resource "google_x" "y" {\n  a = [1\n}\n', /never closed/);
    refusesSource('resource "google_x" "y" {\n  a = 1 ]\n}\n', /never opened/);
    refusesSource('locals {\n  /* never closed\n}\n', /comment is never closed/);
    refusesSource('locals {\n  a = <<EOT\nx\nEOT\n}\n', /heredoc/);
    refusesSource('locals {\n  a = "${ never"\n}\n', /runs over a line|never closed/);
    refusesSource("locals {\n  a = `x`\n}\n", /character HCL does not use/);
    refusesSource('locals {\n  a\n}\n', /neither a block nor an attribute/);
    refusesSource('locals {\n  a = \n}\n', /has no value/);
    refusesSource('locals { a = 1 } provisioner "x" {}\n', /provisioner/);
    refusesSource('resource "google_${x}" "y" {\n}\n', /interpolation/);
  });

  it("is not fooled by text that looks like structure", () => {
    // Braces, comment markers and quotes inside strings and comments do not move the blocks.
    const decoys = 'locals {\n  a = "} # {"\n  b = "// }"\n  c = "\\" } \\""\n}\n';
    validateSource(`${decoys}resource "google_storage_bucket" "x" {\n  name = "${"${var.name_prefix}"}-x" # } provisioner\n  /* provisioner "local-exec" { */\n}\n`, "x.tf");
    refusesSource(`${decoys}resource "terraform_data" "x" {\n}\n`, /not of an allowed provider/);
    refusesSource(`${decoys}module "x" {\n}\n`, /module block/);
    refusesSource('locals {\n  a = "}"\n}\nterraform {\n  backend "s3" {\n  }\n}\n', /not backend/);
    // `$${` is text, so what follows it is not an interpolation; an interpolation's own braces nest.
    validateSource('locals {\n  a = "$${file(x)}"\n  b = "${ { c = 1 }.c }"\n}\n', "x.tf");
    refusesSource('locals {\n  a = "$${x} ${file(y)}"\n}\n', /function file/);
    // One-line blocks and objects spread over lines.
    validateSource('variable "x" { type = string }\nlocals {\n  m = {\n    a = 1,\n    b = [\n      2,\n    ]\n  }\n}\n', "x.tf");
  });

  it("refuses the plans on the command line, with a message that cannot start a workflow command", () => {
    const script = new URL("../scripts/sandbox-gcp-validate.mjs", import.meta.url).pathname;
    const good = plans();
    const ok = spawnSync("node", [script, good], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^The 4 plans \(\d+ files\) are what the generator writes\.\ndigest sha256:[0-9a-f]{64}\n$/);
    const bad = plans();
    write(bad, "gcp-site/main.tf", `${read(bad, "gcp-site/main.tf")}\nmodule "x" {\n}\n`);
    write(bad, "gcp-site/x::error::y\u001b.tf", "");
    const fail = spawnSync("node", [script, bad], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.equal(fail.stdout.trim().split("\n").length, 1);
    assert.match(fail.stdout, /^::error::The plans are not what the generator writes, and nothing was run on them: /);
    assert.doesNotMatch(fail.stdout.slice("::error::".length), /::/);
    assert.equal(spawnSync("node", [script], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync("node", [script, good, "x"], { encoding: "utf8" }).status, 2);
  });
});
