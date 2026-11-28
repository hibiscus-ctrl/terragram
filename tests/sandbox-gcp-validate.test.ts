// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { assembleModel } from "terragram-engine/engine";
import { emitTerraform } from "terragram-engine/terraform";
import { GCP_PLANS } from "../scripts/emit-plans.ts";
import { adaptForSandbox } from "../scripts/lib/sandbox-gcp.ts";
import { ALLOWED_DATA, ALLOWED_PROVIDERS, ALLOWED_RESOURCES, DENIED_DATA, PINNED_SOURCES, PLAN_IDS, PlanRejected, validatePlans, validateSource } from "../scripts/sandbox-gcp-validate.mjs";

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
    refusesAppended('data "external" "x" {\n  program = ["sh", "-c", "id"]\n}', /data external is not a data source the generator writes/);
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

  it("allows exactly the resource and data source types the four plans and the network root contain", () => {
    const root = plans();
    const texts = PLAN_IDS.flatMap((id) => readdirSync(join(root, id)).filter((n) => n.endsWith(".tf")).map((n) => read(root, `${id}/${n}`)));
    texts.push(readFileSync(new URL("../scripts/sandbox-gcp-network/main.tf", import.meta.url), "utf8"));
    const types = (kind: string) => [...new Set(texts.flatMap((t) => [...t.matchAll(new RegExp(`^${kind} "([^"]+)" "`, "gm"))].map((m) => m[1] as string)))].sort();
    assert.deepEqual([...ALLOWED_RESOURCES].sort(), types("resource"), "ALLOWED_RESOURCES is what the generator writes: add a new type to it, and remove one it no longer writes");
    assert.deepEqual([...ALLOWED_DATA].sort(), types("data"), "ALLOWED_DATA is what the generator writes");
    for (const type of ALLOWED_RESOURCES) assert.match(type, /^google_[a-z0-9_]+$/);
  });

  it("refuses a type the generator does not write, though it is of an allowed provider", () => {
    refusesAppended('resource "google_compute_vpn_gateway" "x" {\n}', /resource google_compute_vpn_gateway is not a resource type the generator writes/);
    refusesAppended('resource "google_service_account_key" "x" {\n}', /google_service_account_key is not a resource type/);
    refusesAppended('data "google_compute_instance" "x" {\n}', /data google_compute_instance is not a data source the generator writes/);
    // A type the generator starts to write fails the plans until it is listed.
    refusesWhole((r) => write(r, "gcp-site/main.tf", read(r, "gcp-site/main.tf").replace('resource "google_compute_url_map"', 'resource "google_compute_region_url_map"')), /google_compute_region_url_map is not a resource type/);
    // An escape in a label does not spell a listed type.
    refusesAppended('resource "google_storage_\\u0062ucket" "x" {\n}', /is not a resource type/);
  });

  it("refuses the data sources that hand out a token, as blocks and as references, even if they are listed", () => {
    const tokens = [...DENIED_DATA];
    assert.equal(tokens.length, 5);
    const exposing = ["google_client_config", "google_service_account_access_token", "google_service_account_id_token", "google_service_account_jwt", "google_client_openid_userinfo"];
    assert.deepEqual([...tokens].sort(), [...exposing].sort());
    for (const type of exposing) {
      refusesAppended(`data "${type}" "x" {\n}`, /hands out a token/);
      refusesAppended(`locals {\n  t = data.${type}.x.access_token\n}`, /hands out a token/);
      refusesAppended(`resource "google_storage_bucket_object" "x" {\n  name    = "x"\n  bucket  = "b"\n  content = data.${type}.x.access_token\n}`, /bucket object may set only/);
      ALLOWED_DATA.add(type);
      try {
        refusesAppended(`data "${type}" "x" {\n}`, /hands out a token/);
        refusesAppended(`locals {\n  t = data.${type}.x.access_token\n}`, /hands out a token/);
      } finally {
        ALLOWED_DATA.delete(type);
      }
    }
    refusesAppended('locals {\n  t = data["google_client_config"]\n}', /not written plainly/);
    refusesAppended('locals {\n  t = "${data.google_client_config.x.access_token}"\n}', /hands out a token/);
    refusesAppended('locals {\n  t = data.google_secret_manager_secret_version.x.secret_data\n}', /hands out a token/);
  });

  it("refuses an attribute that reads a local path, and a bucket object that is not its archive", () => {
    const object = (attrs: string) => `resource "google_storage_bucket_object" "x" {\n  name   = "x"\n  bucket = "b"\n${attrs}\n}`;
    refusesAppended(object('  source = "/etc/passwd"'), /source may only be the output_path/);
    refusesAppended(object('  source = "${path.module}/src/x"'), /source may only be the output_path/);
    refusesAppended(object("  source = data.archive_file.not_declared.output_path"), /source may only be the output_path/);
    refusesAppended(object("  source = data.archive_file.functions.output_base64sha256"), /source may only be the output_path/);
    refusesAppended(object("  source = data.google_project.x.number"), /source may only be the output_path|data google_project/);
    refusesAppended(object('  source_file = "/etc/passwd"'), /bucket object may set only/);
    refusesAppended(object('  content = "inline"'), /bucket object may set only/);
    refusesAppended(object("  content = data.google_project.x.number"), /bucket object may set only/);
    refusesAppended(object("  content = jsonencode(data.google_storage_project_service_account.x)"), /bucket object may set only/);
    refusesAppended(object("  retention {\n  }"), /bucket object may set only/);
    refusesAppended('resource "google_storage_bucket" "x" {\n  name   = "x"\n  source = "/etc/passwd"\n}', /the attribute source/);
    refusesAppended('resource "google_storage_bucket" "x" {\n  name = "x"\n  inner {\n    source_dir = "/"\n  }\n}', /the attribute source_dir/);
    refusesAppended('resource "google_compute_instance" "x" {\n  credentials = "x"\n}', /the attribute credentials/);
    refusesAppended('resource "google_storage_bucket" "x" {\n  name = path.module\n}', /reference to path/);
    refusesAppended('output "x" {\n  value = path["cwd"]\n}', /reference to path/);
    refusesAppended('output "x" {\n  value = "${path.root}"\n}', /reference to path/);
    // What the generator writes is its archive, and its own placeholder.
    validateSource(object("  source = data.archive_file.functions.output_path").replace('resource', 'data "archive_file" "functions" {\n  type        = "zip"\n  source_dir  = "${path.module}/src/functions"\n  output_path = "${path.module}/.terraform/functions.zip"\n}\n\nresource'), "x.tf");
  });

  it("refuses a function that reads the disk wherever the name is, whatever follows it", () => {
    const names = ["file", "fileset", "filebase64", "filebase64sha256", "filebase64sha512", "filesha1", "filesha256", "filesha512", "filemd5", "fileexists", "templatefile", "templatestring", "abspath", "pathexpand"];
    for (const name of names) {
      const why = new RegExp(`the function ${name}`);
      for (const call of [`${name}("/etc/passwd")`, `${name}\n("/etc/passwd")`, `${name} /* c */ ("/etc/passwd")`, `${name} # c\n("/etc/passwd")`, `${name} // c\n("/etc/passwd")`, `${name}\n\n  ("/etc/passwd")`, `${name}`, `${name.toUpperCase()}("x")`, `x.${name}`]) {
        // Where the parser may see a newline between the name and its parenthesis: in brackets, where HCL skips them.
        refusesSource(`locals {\n  x = [\n    ${call}\n  ]\n}\n`, new RegExp(`the function ${name}`, "i"));
        refusesSource(`locals {\n  x = (${call})\n}\n`, new RegExp(`the function ${name}`, "i"));
        refusesSource(`locals {\n  x = "a ${"$"}{ ${call} } b"\n}\n`, new RegExp(`the function ${name}`, "i"));
      }
      refusesSource(`locals {\n  x = ${name}("/etc/passwd")\n}\n`, why);
    }
    refusesSource('locals {\n  x = "${ "${ file("/etc/passwd") }" }"\n}\n', /the function file/);
    // A run of three `$` or `%` before a brace is one HCL and this tokenizer might read differently: refused.
    refusesSource('locals {\n  x = "$$${file(y)}"\n}\n', /run of three or more \$ before a brace/);
    refusesSource('locals {\n  x = "$$$${file(y)}"\n}\n', /run of three or more \$ before a brace/);
    refusesSource('locals {\n  x = "%%%{ if true }"\n}\n', /run of three or more % before a brace/);
    validateSource('locals {\n  x = "a $${file(y)} $${b} %%{c}"\n}\n', "x.tf");
    refusesSource('locals {\n  x = "%{ if true }${file(y)}%{ endif }"\n}\n', /the function file/);
    refusesSource('locals {\n  x = "${~ file(y) ~}"\n}\n', /the function file/);
    refusesSource('locals {\n  x = provider\n  ::external::run()\n}\n', /function of a provider/);
    refusesSource("locals {\n  x = [provider\n  /* c */ ::external::run()]\n}\n", /function of a provider/);
    refusesSource("locals {\n  x = provider::external::run()\n}\n", /function of a provider/);
    refusesSource("locals {\n  x = core::file(y)\n}\n", /function of a provider|the function file/);
  });

  it("refuses what HCL would read differently from the tokenizer", () => {
    // A character HCL does not use outside a string, among them the letters of a Unicode identifier.
    refusesSource('locals {\n  x = \uFB01le("/etc/passwd")\n}\n', /character HCL does not use/);
    refusesSource('locals {\n  x = fil\u0435("/etc/passwd")\n}\n', /character HCL does not use/);
    refusesSource("locals {\n  x\u00a0= 1\n}\n", /character HCL does not use/);
    // An escape HCL does not read, a unicode escape that is cut short, and a line ending of a lone carriage return.
    refusesSource('locals {\n  x = "\\q${file(y)}"\n}\n', /escape in a string/);
    refusesSource('locals {\n  x = "\\$"\n}\n', /escape in a string/);
    refusesSource('locals {\n  x = "\\u12"\n}\n', /escape in a string/);
    refusesSource('locals {\n  x = "\\U0000004"\n}\n', /escape in a string/);
    refusesSource('locals {\n  x = "a\\\nb"\n}\n', /escape in a string/);
    refusesSource('locals {\n  x = 1 # a comment\rprovisioner "x" {}\n}\n', /carriage return/);
    refusesSource('locals {\n  x = "a\rb"\n}\n', /carriage return/);
    refusesSource("locals {\n  x = 1\u0085\n}\n", /control or direction-changing/);
    refusesSource("locals {\n  x = 1\u2028\n}\n", /control or direction-changing/);
    // The escapes it reads are read, and a quote it escapes does not end the string.
    validateSource('locals {\n  a = "q\\" \\u0041 \\U00000041 \\n \\t \\r \\\\ ${var.x}"\n  b = "x" # \\\n}\n', "x.tf");
    refusesSource('locals {\n  a = "\\" ${file(y)} \\""\n}\n', /the function file/);
    // A comment of either kind, a string, and a template directive hide nothing from the checks that follow them.
    refusesSource('locals {\n  a = "x" // "\n  b = file(y)\n}\n', /the function file/);
    refusesSource('locals {\n  a = "x" # "\n  b = file(y)\n}\n', /the function file/);
    refusesSource('locals {\n  a = 1 /* " */ + file(y)\n}\n', /the function file/);
    refusesSource('locals {\n  a = "/* "\n  b = file(y) /* */\n}\n', /the function file/);
    refusesSource('locals {\n  a = "// ${file(y)}"\n}\n', /the function file/);
    refusesSource('locals {\n  a = "# ${file(y)}"\n}\n', /the function file/);
    refusesSource('locals {\n  a = "%{ for x in y }${file(x)}%{ endfor }"\n}\n', /the function file/);
    // A block's type or label spelt with an escape is not the type it spells.
    refusesSource('resource "google_storage_bucket" "x" {\n  provisioner\n  "local-exec" {\n  }\n}\n', /provisioner|neither a block/);
    refusesSource('locals {\n  a = "local\\u002dexec"\n  b = "LOCAL-EXEC"\n}\n', /local-exec or remote-exec/);
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
    refusesSource(`${decoys}resource "terraform_data" "x" {\n}\n`, /not a resource type the generator writes/);
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
