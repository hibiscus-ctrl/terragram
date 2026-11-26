// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { buildEvidenceReceipt } from "terragram-engine/build-receipt";
import { modelToSvg } from "terragram-engine/diagram-svg";
import { composeFromPrompt } from "terragram-engine/engine";
import { explainModel } from "terragram-engine/explain";
import { parseMermaid } from "terragram-engine/interchange";
import { CLOUDS, type InfraModel } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";
import type { Signer } from "terragram-engine/ports";
import { buildBundle } from "terragram-engine/receipt";
import { SAMPLE_MERMAID, SAMPLE_TERRAFORM } from "terragram-engine/samples";
import { emitTerraform } from "terragram-engine/terraform";
import { templateModel, WORKSPACE_TEMPLATES } from "terragram-engine/templates";

import { run } from "../packages/cli/src/cli.ts";
import { type Io, writeUnder } from "../packages/cli/src/io.ts";
import { BRIEFS } from "../scripts/emit-briefs.ts";

/**
 * The CLI is a front door onto the engine, so its output must be the engine's output
 * byte for byte. These run the commands in-process over the documents the emit gate
 * (scripts/validate-emit.ts) generates from, and compare with what the engine functions
 * (`emitTerraform`, `modelToSvg`, `explainModel`) return.
 */

const scratch = mkdtempSync(join(tmpdir(), "terragram-cli-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function fresh(name: string): string {
  const dir = join(scratch, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function capture(cwd = scratch) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => void out.push(t), err: (t) => void err.push(t), cwd };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

async function cli(args: string[]) {
  const c = capture();
  const code = await run(args, c.io);
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

function readTree(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath, e.name);
        return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
      }),
  );
}

const terraformInstalled = spawnSync("terraform", ["version"], { stdio: "ignore" }).status === 0;

function modelValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(readFileSync(new URL("../schemas/model.v1.schema.json", import.meta.url), "utf8")),
  );
}
const validModel = modelValidator();

const BRIEF_WEB = BRIEFS[1] ?? "";
const BRIEF_API = BRIEFS[2] ?? "";

describe("terragram generate matches the engine's emit path", () => {
  for (const [i, brief] of BRIEFS.entries()) {
    for (const cloud of CLOUDS) {
      it(`brief ${i + 1} on ${cloud}`, async () => {
        const out = fresh("gen");
        const result = await cli(["generate", "--prompt", brief, "--cloud", cloud, "-o", out]);
        assert.equal(result.code, 0, result.stderr);

        const composed = composeFromPrompt(brief).model;
        const expected = emitTerraform(composed, cloud);
        const { "model.json": modelJson, ...terraform } = readTree(out);
        assert.deepEqual(
          terraform,
          Object.fromEntries(expected.files.map((f) => [f.name, f.content])),
          "the files must equal emitTerraform's, byte for byte",
        );

        const model = JSON.parse(modelJson ?? "{}") as InfraModel & { cloud: string; schema: string };
        assert.equal(model.schema, "diagram.model/v1");
        assert.equal(model.cloud, cloud);
        assert.deepEqual(model.nodes, composed.nodes);
        assert.equal(validModel(model), true);
      });
    }
  }

  it("emits for OpenTofu with --tofu, as the engine does for that tool", async () => {
    const out = fresh("tofu");
    const result = await cli(["generate", "--prompt", BRIEF_WEB, "--cloud", "azure", "--tofu", "-o", out]);
    assert.equal(result.code, 0, result.stderr);
    const expected = emitTerraform(composeFromPrompt(BRIEF_WEB).model, "azure", "opentofu");
    const written = readTree(out);
    for (const file of expected.files) assert.equal(written[file.name], file.content);
  });

  it("takes the cloud the brief names when --cloud is absent, else azure", async () => {
    const aws = await cli(["generate", "--prompt", BRIEFS[0] ?? "", "-o", fresh("auto"), "--json"]);
    assert.equal((JSON.parse(aws.stdout) as { cloud: string }).cloud, "aws");
    const plain = await cli(["generate", "--prompt", BRIEF_WEB, "-o", fresh("auto"), "--json"]);
    assert.equal((JSON.parse(plain.stdout) as { cloud: string }).cloud, "azure");
  });

  it("reads a Mermaid flowchart", async () => {
    const dir = fresh("mmd");
    const file = join(dir, "diagram.mmd");
    writeFileSync(file, SAMPLE_MERMAID);
    const out = join(dir, "out");
    const result = await cli(["generate", "--mermaid", file, "--cloud", "aws", "-o", out]);
    assert.equal(result.code, 0, result.stderr);
    const read = parseMermaid(SAMPLE_MERMAID);
    assert.ok(read.ok);
    const written = readTree(out);
    for (const f of emitTerraform(read.model, "aws").files) assert.equal(written[f.name], f.content);
  });

  it("reads a Mermaid architecture-beta diagram and prints what it could not keep as warnings", async () => {
    const dir = fresh("arch");
    const file = join(dir, "architecture.mmd");
    const source = `architecture-beta
  group api(cloud)[API]
  service web(server)[Web app] in api
  service db(database)[Postgres database] in api
  service fn(logos:aws-lambda)[Worker] in api
  web:R --> L:db
  web:B --> T:fn
`;
    writeFileSync(file, source);
    const out = join(dir, "out");
    const result = await cli(["generate", "--mermaid", file, "--cloud", "aws", "-o", out]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /warning: group "API" is not kept/);
    assert.match(result.stderr, /warning: service "fn": icon "logos:aws-lambda" is not a built-in icon/);
    assert.match(result.stderr, /not translated: Worker/);
    const read = parseMermaid(source);
    assert.ok(read.ok);
    const written = readTree(out);
    for (const f of emitTerraform(read.model, "aws").files) assert.equal(written[f.name], f.content);

    const bad = await cli(["generate", "--mermaid", file.replace("architecture", "missing"), "-o", out]);
    assert.notEqual(bad.code, 0);
    writeFileSync(file, "architecture-beta\n  service a(server)[A]\n  a:R -- L:b\n");
    const refused = await cli(["generate", "--mermaid", file, "-o", join(dir, "none")]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Line 3: the edge uses "b"/);
  });

  it(
    "writes Terraform that terraform fmt leaves alone",
    { skip: !terraformInstalled && "terraform is not installed" },
    async () => {
      for (const brief of BRIEFS) {
        for (const cloud of CLOUDS) {
          const out = fresh("fmt");
          assert.equal((await cli(["generate", "--prompt", brief, "--cloud", cloud, "-o", out])).code, 0);
          const fmt = spawnSync("terraform", ["fmt", "-check", "-recursive", "-diff", out], {
            encoding: "utf8",
          });
          assert.equal(fmt.status, 0, `${cloud}: terraform fmt would change the output\n${fmt.stdout}${fmt.stderr}`);
        }
      }
    },
  );

  it("reports what could not be built instead of hiding it", async () => {
    const result = await cli(["generate", "--prompt", BRIEFS[0] ?? "", "--cloud", "azure", "-o", fresh("omit"), "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as { files: string[]; omitted: string[]; notes: string[] };
    assert.ok(summary.files.includes("model.json"));
    assert.ok(summary.notes.length >= summary.omitted.length);
  });
});

describe("terragram parse, render and explain", () => {
  it("parses a directory the way the engine parses Terraform", async () => {
    const dir = fresh("tf");
    writeFileSync(join(dir, "main.tf"), SAMPLE_TERRAFORM);
    const out = join(fresh("parse"), "model.json");
    const result = await cli(["parse", dir, "-o", out]);
    assert.equal(result.code, 0, result.stderr);

    const expected = parseTerraform(SAMPLE_TERRAFORM);
    assert.ok(expected.ok);
    const written = JSON.parse(readFileSync(out, "utf8")) as InfraModel & { cloud: string };
    assert.equal(written.cloud, expected.cloud);
    assert.deepEqual(written.nodes, expected.model.nodes);
    assert.deepEqual(written.edges, expected.model.edges);
    assert.equal(validModel(written), true);
  });

  it("round-trips: generated Terraform parses back to the same components", async () => {
    const out = fresh("round");
    await cli(["generate", "--prompt", BRIEF_WEB, "--cloud", "azure", "-o", out]);
    const model = join(fresh("round"), "model.json");
    const result = await cli(["parse", join(out, "main.tf"), "-o", model]);
    assert.equal(result.code, 0, result.stderr);
    const kinds = (path: string) =>
      (JSON.parse(readFileSync(path, "utf8")) as InfraModel).nodes
        .map((n) => n.kind)
        .filter((k) => k !== "internet")
        .sort();
    assert.deepEqual(kinds(model), kinds(join(out, "model.json")));
  });

  it("prints the model on standard output when no -o is given", async () => {
    const file = join(fresh("stdout"), "main.tf");
    writeFileSync(file, SAMPLE_TERRAFORM);
    const result = await cli(["parse", file]);
    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { schema: string }).schema, "diagram.model/v1");
  });

  it("renders the SVG the workspace exports", async () => {
    const model = templateModel(WORKSPACE_TEMPLATES[0] as (typeof WORKSPACE_TEMPLATES)[number]);
    const dir = fresh("render");
    writeFileSync(join(dir, "model.json"), JSON.stringify(model));
    const result = await cli(["render", join(dir, "model.json"), "-o", join(dir, "diagram.svg")]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(join(dir, "diagram.svg"), "utf8"), `${modelToSvg(model)}\n`);
  });

  it("explains every template as the review gate does", async () => {
    for (const template of WORKSPACE_TEMPLATES) {
      const model = templateModel(template);
      const dir = fresh("explain");
      writeFileSync(join(dir, "model.json"), JSON.stringify({ ...model, cloud: "aws" }));
      const result = await cli(["explain", join(dir, "model.json")]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `${explainModel(model, "aws", emitTerraform(model, "aws").regionLabel)}\n`);
    }
  });

  it("refuses a file that is not a model, and says why", async () => {
    const dir = fresh("bad");
    writeFileSync(join(dir, "model.json"), JSON.stringify({ nodes: [{ id: "a" }], edges: [] }));
    const result = await cli(["explain", join(dir, "model.json")]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a diagram model/);
    assert.match(result.stderr, /nodes\.0\.category/);
  });

  it("fails on an empty diagram and on a directory with no Terraform", async () => {
    const dir = fresh("empty");
    writeFileSync(join(dir, "model.json"), JSON.stringify({ nodes: [], edges: [] }));
    assert.equal((await cli(["render", join(dir, "model.json")])).code, 1);
    assert.equal((await cli(["parse", dir])).code, 1);
  });
});

describe("terragram verify", () => {
  /**
   * A bundle on disk as `buildBundle` lays it out, and the signer's public key kept
   * OUTSIDE it: that separate copy is the only thing a verifier may trust.
   */
  async function bundleDir(options: { signed: boolean }) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const signer: Signer = {
      keyId: "test-key",
      signedAt: "2026-09-11T00:00:01Z",
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      publicKeyPem: pem,
      sign: (bytes) => signBytes(null, Buffer.from(bytes), privateKey).toString("base64"),
    };
    const { model } = composeFromPrompt(BRIEF_WEB);
    const built = await buildEvidenceReceipt(model, "azure", "deterministic", "alice", "2026-09-11T00:00:00Z", {
      nodeVersion: "v24.0.0",
      ...(options.signed ? { signer } : {}),
    });
    const dir = fresh("bundle");
    for (const entry of buildBundle(built.receipt, model, built.terraform.files, built.attestation)) {
      mkdirSync(dirname(join(dir, entry.name)), { recursive: true });
      writeFileSync(join(dir, entry.name), entry.content);
    }
    const trustedKey = join(fresh("trusted"), "signer.pem");
    writeFileSync(trustedKey, pem);
    return { dir, trustedKey };
  }

  it("verifies a signed bundle against the trusted key: hash, signature, key and detached signature", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const result = await cli(["verify", dir, "--key", trustedKey]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /hash: {6}pass/);
    assert.match(result.stdout, /signature: pass/);
    assert.match(result.stdout, /key: {7}pass/);
    assert.match(result.stdout, /detached: {2}pass/);
    assert.match(result.stdout, /^verified$/m);
  });

  it("takes the key from a trust file by the receipt's key id", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const trust = join(fresh("trust"), "trust.json");
    writeFileSync(trust, JSON.stringify({ "other-key": "junk", "test-key": readFileSync(trustedKey, "utf8") }));
    assert.equal((await cli(["verify", dir, "--trust", trust])).code, 0);

    const unknown = join(fresh("trust"), "trust.json");
    writeFileSync(unknown, JSON.stringify({ "someone-else": readFileSync(trustedKey, "utf8") }));
    const result = await cli(["verify", dir, "--trust", unknown]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /not in/);
  });

  it("does not verify an unsigned receipt unless told to check hashes only", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: false });
    for (const args of [["--key", trustedKey], []]) {
      const result = await cli(["verify", dir, ...args]);
      assert.notEqual(result.code, 0, `terragram verify ${args.join(" ")}`);
      assert.doesNotMatch(result.stdout, /^verified$/m);
    }
    const noKey = await cli(["verify", dir]);
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /--allow-unsigned/);
    const keyed = await cli(["verify", dir, "--key", trustedKey]);
    assert.equal(keyed.code, 1);
    assert.match(keyed.stdout, /UNSIGNED/);
  });

  it("with --allow-unsigned checks the hashes and says plainly the receipt is UNSIGNED", async () => {
    const { dir } = await bundleDir({ signed: false });
    const result = await cli(["verify", dir, "--allow-unsigned"]);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /hash: {6}pass/);
    assert.match(result.stdout, /^UNSIGNED: hashes checked only/m);
    assert.doesNotMatch(result.stdout, /^verified$/m);
    assert.equal((JSON.parse((await cli(["verify", dir, "--allow-unsigned", "--json"])).stdout) as { verdict: string }).verdict, "unsigned");

    const main = join(dir, "plan", "main.tf");
    writeFileSync(main, `${readFileSync(main, "utf8")}\n# tampered\n`);
    assert.equal((await cli(["verify", dir, "--allow-unsigned"])).code, 1, "a changed plan still fails the hash");
  });

  it("still checks a receipt that carries the codename schema id it was written under", async () => {
    // A v2 receipt, as issued before v3, with its signature stripped for --allow-unsigned.
    const dir = fresh("bundle-v2");
    cpSync(join(import.meta.dirname, "fixtures", "receipt-v2"), dir, { recursive: true });
    const receipt = join(dir, "receipt.json");
    const stripped = JSON.parse(readFileSync(receipt, "utf8")) as Record<string, unknown>;
    stripped.signed = false;
    stripped.signature = null;
    stripped.publicKey = null;
    writeFileSync(receipt, JSON.stringify(stripped, null, 2));
    const body = readFileSync(receipt, "utf8");
    assert.match(body, /"diagram\.receipt\/v2"/);
    const current = await cli(["verify", dir, "--allow-unsigned"]);
    assert.equal(current.code, 0, current.stdout);
    for (const oldId of ["terragram.receipt/v1", "terragram.receipt/v2"]) {
      writeFileSync(receipt, body.replace("diagram.receipt/v2", oldId));
      const result = await cli(["verify", dir, "--allow-unsigned"]);
      assert.equal(result.code, 0, `${oldId}: ${result.stdout}`);
      assert.match(result.stdout, /hash: {6}pass/);
    }
  });

  it("refuses --allow-unsigned with a trusted key, so stripping a signature cannot pass", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const receipt = join(dir, "receipt.json");
    const stripped = JSON.parse(readFileSync(receipt, "utf8")) as Record<string, unknown>;
    stripped.signed = false;
    delete stripped.signature;
    delete stripped.publicKey;
    writeFileSync(receipt, JSON.stringify(stripped, null, 2));
    const combined = await cli(["verify", dir, "--key", trustedKey, "--allow-unsigned"]);
    assert.equal(combined.code, 2);
    assert.match(combined.stderr, /cannot be combined/);
    assert.equal((await cli(["verify", dir, "--key", trustedKey])).code, 1);
  });

  it("never reports a signed bundle as verified without a trusted key, even with --allow-unsigned", async () => {
    const { dir } = await bundleDir({ signed: true });
    assert.equal((await cli(["verify", dir])).code, 2);
    const result = await cli(["verify", dir, "--allow-unsigned"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /UNSIGNED/);
    assert.match(result.stdout, /signature: unavailable/);
    assert.doesNotMatch(result.stdout, /^verified$/m);
  });

  it("ignores the key shipped inside the bundle", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    // The bundle carries signing-key.pem and receipt.json.sig, and they are consistent.
    // Without a key from outside, that must not be enough.
    assert.equal((await cli(["verify", dir])).code, 2);

    // An attacker alters the receipt, re-signs it with their own key, and ships that
    // key (and a matching detached signature) inside the bundle.
    const attacker = generateKeyPairSync("ed25519");
    const receiptPath = join(dir, "receipt.json");
    const forged = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, string>;
    forged.approver = "mallory";
    forged.publicKey = attacker.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    forged.signature = signBytes(null, Buffer.from(forged.contentHash ?? ""), attacker.privateKey).toString("base64");
    const forgedText = `${JSON.stringify(forged, null, 2)}\n`;
    writeFileSync(receiptPath, forgedText);
    writeFileSync(join(dir, "receipt.json.sig"), signBytes(null, Buffer.from(forgedText), attacker.privateKey).toString("base64"));
    writeFileSync(join(dir, "signing-key.pem"), attacker.publicKey.export({ type: "spki", format: "pem" }).toString());

    // Self-consistent inside, and still refused: the trusted key does not match.
    const result = await cli(["verify", dir, "--key", trustedKey]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /key: {7}fail/);
    assert.match(result.stdout, /NOT verified/);
    assert.equal((await cli(["verify", dir])).code, 2, "still no key from outside, still not checked");
  });

  it("fails when the trusted key is not the key the receipt carries", async () => {
    const { dir } = await bundleDir({ signed: true });
    const other = join(fresh("trusted"), "other.pem");
    writeFileSync(other, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
    const result = await cli(["verify", dir, "--key", other]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /key: {7}fail/);
    assert.match(result.stdout, /signature: fail/);
    assert.doesNotMatch(result.stdout, /^verified$/m);
  });

  it("takes the detached signature by flag, from anywhere", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const elsewhere = fresh("sig");
    writeFileSync(join(elsewhere, "r.sig"), readFileSync(join(dir, "receipt.json.sig")));
    rmSync(join(dir, "receipt.json.sig"));
    const result = await cli(["verify", join(dir, "receipt.json"), "--sig", join(elsewhere, "r.sig"), "--key", trustedKey, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { verdict: string; detached: { status: string } };
    assert.equal(report.verdict, "verified");
    assert.equal(report.detached.status, "pass");
  });

  it("fails when a plan file has changed since approval", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const main = join(dir, "plan", "main.tf");
    writeFileSync(main, `${readFileSync(main, "utf8")}\n# tampered\n`);
    const result = await cli(["verify", dir, "--key", trustedKey]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /hash: {6}fail/);
    assert.match(result.stdout, /NOT verified/);
  });

  it("fails when receipt.json changed after it was signed", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const path = join(dir, "receipt.json");
    const text = readFileSync(path, "utf8");
    assert.match(text, /"approver": "alice"/);
    writeFileSync(path, text.replace('"approver": "alice"', '"approver": "mallory"'));
    const result = await cli(["verify", dir, "--key", trustedKey]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /detached: {2}fail/);
  });

  it("cannot hash-check a receipt on its own, and says so", async () => {
    const { dir, trustedKey } = await bundleDir({ signed: true });
    const lone = fresh("lone");
    writeFileSync(join(lone, "receipt.json"), readFileSync(join(dir, "receipt.json")));
    const result = await cli(["verify", join(lone, "receipt.json"), "--key", trustedKey]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /hash: {6}unavailable/);
  });

  it("exits 1 for a file that is not a receipt, and 2 for arguments that cannot work", async () => {
    const dir = fresh("junk");
    writeFileSync(join(dir, "receipt.json"), "not json");
    assert.equal((await cli(["verify", join(dir, "receipt.json"), "--allow-unsigned"])).code, 1);
    assert.equal((await cli(["verify", join(dir, "receipt.json"), "--sig", "x"])).code, 2);
    assert.equal((await cli(["verify", join(dir, "receipt.json"), "--key", "a", "--trust", "b"])).code, 2);
  });
});

describe("arguments, help and exit codes", () => {
  it("prints the version and the help with status 0", async () => {
    assert.match((await cli(["--version"])).stdout, /^\d+\.\d+\.\d+\n$/);
    const help = await cli(["--help"]);
    assert.equal(help.code, 0);
    for (const command of ["generate", "parse", "render", "explain", "verify"]) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, "m"));
      const sub = await cli([command, "--help"]);
      assert.equal(sub.code, 0);
      assert.match(sub.stdout, /^Usage: terragram /);
    }
  });

  it("exits 2 for usage errors, with the reason on stderr", async () => {
    const cases: string[][] = [
      [],
      ["frobnicate"],
      ["generate"],
      ["generate", "--prompt", "a web app"],
      ["generate", "--prompt", "a web app", "--mermaid", "x.mmd", "-o", "out"],
      ["generate", "--prompt", "a web app", "-o", "out", "--cloud", "gcp"],
      ["generate", "--prompt", "a web app", "-o", "out", "--nope"],
      ["parse"],
      ["render"],
      ["explain", "a.json", "b.json"],
      ["verify"],
    ];
    for (const args of cases) {
      const result = await cli(args);
      assert.equal(result.code, 2, `terragram ${args.join(" ")}`);
      assert.ok(result.stderr.length > 0);
    }
  });

  it("exits 1 when asked to build something it does not recognise", async () => {
    const result = await cli(["generate", "--prompt", "make me a sandwich", "-o", fresh("none")]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /nothing to build/);
  });

  it("reaches the engine only through its public exports", () => {
    const exported = new Set(
      Object.keys(
        (JSON.parse(readFileSync(new URL("../packages/engine/package.json", import.meta.url), "utf8")) as {
          exports: Record<string, string>;
        }).exports,
      ).map((subpath) => `terragram-engine/${subpath.slice(2)}`),
    );
    const sources = readdirSync(new URL("../packages/cli/src", import.meta.url), {
      recursive: true,
      withFileTypes: true,
    }).filter((e) => e.isFile() && e.name.endsWith(".ts"));
    assert.ok(sources.length >= 8);
    for (const source of sources) {
      const text = readFileSync(join(source.parentPath, source.name), "utf8");
      for (const m of text.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm)) {
        const specifier = m[1] ?? "";
        const allowed = specifier.startsWith(".") || specifier.startsWith("node:") || exported.has(specifier);
        assert.ok(allowed, `${source.name} imports ${specifier}`);
      }
    }
  });

  it("never writes outside the output directory", () => {
    const { io } = capture(scratch);
    assert.throws(() => writeUnder(io, fresh("jail"), "../escape.tf", "x"), /outside the output directory/);
    assert.throws(() => writeUnder(io, fresh("jail"), "/etc/escape.tf", "x"), /outside the output directory/);
  });

  it("stays deterministic: the same brief writes the same bytes twice", async () => {
    const a = fresh("det");
    const b = fresh("det");
    await cli(["generate", "--prompt", BRIEF_API, "--cloud", "aws", "-o", a]);
    await cli(["generate", "--prompt", BRIEF_API, "--cloud", "aws", "-o", b]);
    assert.deepEqual(readTree(a), readTree(b));
  });
});
