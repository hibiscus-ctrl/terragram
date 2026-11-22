// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { COMMENT_MARKER } from "../action/src/comment.ts";
import { run as terragram } from "../packages/cli/src/cli.ts";
import type { Io } from "../packages/cli/src/io.ts";

/**
 * The built Action, run the way the runner runs it: `node index.mjs` in the workspace,
 * inputs in `INPUT_*`, outputs read back from `GITHUB_OUTPUT`, GitHub's API replaced by a
 * local server. The fixture is a model, and the Terraform the engine generates for it.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "tests/fixtures/action");
const scratch = mkdtempSync(join(tmpdir(), "terragram-action-test-"));
const bundle = join(scratch, "index.mjs");
after(() => rmSync(scratch, { recursive: true, force: true }));

before(() => {
  // Built into the scratch directory: the committed dist/ is checked by action-bundle.test.ts.
  execFileSync(process.execPath, [join(root, "action/build.mjs"), "--outfile", bundle], { cwd: root, stdio: "pipe" });
});

let counter = 0;
function workspace(): string {
  const dir = join(scratch, `ws-${counter++}`);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

type Outcome = { status: number | null; stdout: string; outputs: Record<string, string>; summary: string };

function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+)<<(terragram_[0-9a-f-]+)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const value: string[] = [];
    for (i += 1; lines[i] !== match[2]; i++) value.push(lines[i] ?? "");
    out[match[1] as string] = value.join("\n");
  }
  return out;
}

function environment(ws: string, inputs: Record<string, string>, extra: Record<string, string>) {
  const files = { out: join(ws, "..", `out-${counter++}`), summary: join(ws, "..", `summary-${counter++}`) };
  writeFileSync(files.out, "");
  writeFileSync(files.summary, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GITHUB_WORKSPACE: ws,
    GITHUB_OUTPUT: files.out,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_EVENT_NAME: "push",
    ...extra,
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  return { env, files };
}

function finish(status: number | null, stdout: string, files: { out: string; summary: string }): Outcome {
  return {
    status,
    stdout,
    outputs: parseOutputs(readFileSync(files.out, "utf8")),
    summary: readFileSync(files.summary, "utf8"),
  };
}

function action(ws: string, inputs: Record<string, string> = {}, extra: Record<string, string> = {}): Outcome {
  const { env, files } = environment(ws, inputs, extra);
  const result = spawnSync(process.execPath, [bundle], { cwd: ws, env, encoding: "utf8" });
  return finish(result.status, `${result.stdout}${result.stderr}`, files);
}

/** Asynchronous, so a server in this process can answer while the Action runs. */
function actionAsync(ws: string, inputs: Record<string, string>, extra: Record<string, string>): Promise<Outcome> {
  const { env, files } = environment(ws, inputs, extra);
  return new Promise((resolve) => {
    execFile(process.execPath, [bundle], { cwd: ws, env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve(finish(error ? ((error as { code?: number }).code ?? 1) : 0, `${stdout}${stderr}`, files));
    });
  });
}

const read = (ws: string, ...parts: string[]) => readFileSync(join(ws, ...parts), "utf8");

function verify(args: string[]): Promise<{ code: number; stdout: string }> {
  const out: string[] = [];
  const io: Io = { out: (t) => void out.push(t), err: (t) => void out.push(t), cwd: scratch };
  return terragram(["verify", ...args], io).then((code) => ({ code, stdout: out.join("") }));
}

describe("check mode", () => {
  it("passes on Terraform that matches the model, and writes a receipt that verifies", async () => {
    const ws = workspace();
    const result = action(ws);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.outputs.changed, "false");
    assert.equal(result.outputs["receipt-path"], "_diagram/receipt.json");
    assert.match(result.outputs["content-hash"] ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.parse(read(ws, "_diagram/receipt.json")).contentHash, result.outputs["content-hash"]);
    assert.ok(existsSync(join(ws, "_diagram/model.json")));
    assert.ok(existsSync(join(ws, "_diagram/plan/main.tf")));
    assert.equal(existsSync(join(ws, "_diagram/receipt.json.sig")), false, "unsigned: no signature file");
    assert.equal((await verify([join(ws, "_diagram"), "--allow-unsigned"])).code, 0);
    assert.match(result.summary, /`infra\/` matches `diagram\.json`/);
    assert.equal(read(ws, "infra/main.tf"), read(fixture, "infra/main.tf"), "check never writes to the terraform directory");
  });

  it("fails on drift, prints the unified diff, annotates the file and leaves it untouched", () => {
    const ws = workspace();
    const drifted = `${read(ws, "infra/main.tf")}\nresource "aws_s3_bucket" "rogue" {}\n`;
    writeFileSync(join(ws, "infra/main.tf"), drifted);
    const result = action(ws);
    assert.equal(result.status, 1);
    assert.equal(result.outputs.changed, "true");
    assert.match(result.stdout, /^::error file=infra\/main\.tf::/m);
    assert.match(result.stdout, /--- a\/infra\/main\.tf\n\+\+\+ b\/infra\/main\.tf\n@@ /);
    assert.match(result.stdout, /^-resource "aws_s3_bucket" "rogue" \{\}$/m);
    assert.equal(read(ws, "infra/main.tf"), drifted);
    assert.ok(existsSync(join(ws, "_diagram/receipt.json")), "the receipt is written even when the check fails");
  });

  it("fails when a generated file is missing", () => {
    const ws = workspace();
    rmSync(join(ws, "infra/outputs.tf"));
    const result = action(ws);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /infra\/outputs\.tf is missing/);
    assert.match(result.stdout, /--- \/dev\/null/);
  });

  it("does not mind CRLF line endings, or other files in the directory", () => {
    const ws = workspace();
    for (const name of ["main.tf", "variables.tf", "outputs.tf"]) {
      writeFileSync(join(ws, "infra", name), read(ws, "infra", name).replaceAll("\n", "\r\n"));
    }
    writeFileSync(join(ws, "infra/terraform.tfvars"), 'region = "eu-west-1"\n');
    assert.equal(action(ws).status, 0);
  });

  it("reads the model and the directory from the inputs", () => {
    const ws = workspace();
    mkdirSync(join(ws, "deploy/stack"), { recursive: true });
    cpSync(join(ws, "infra"), join(ws, "deploy/stack/tf"), { recursive: true });
    cpSync(join(ws, "diagram.json"), join(ws, "deploy/stack/model.json"));
    const result = action(ws, { model: "deploy/stack/model.json", "terraform-dir": "deploy/stack/tf" });
    assert.equal(result.status, 0, result.stdout);
  });
});

describe("write mode", () => {
  it("writes the regenerated files, reports changed, and is quiet the second time", () => {
    const ws = workspace();
    rmSync(join(ws, "infra"), { recursive: true });
    const first = action(ws, { mode: "write" });
    assert.equal(first.status, 0, first.stdout);
    assert.equal(first.outputs.changed, "true");
    for (const name of ["main.tf", "variables.tf", "outputs.tf"]) {
      assert.equal(read(ws, "infra", name), read(fixture, "infra", name));
    }
    const second = action(ws, { mode: "write" });
    assert.equal(second.status, 0);
    assert.equal(second.outputs.changed, "false");
    assert.equal(action(ws).status, 0, "check passes after a write");
  });

  it("repairs drift, leaves the other files alone", () => {
    const ws = workspace();
    writeFileSync(join(ws, "infra/variables.tf"), "# hand edit\n");
    writeFileSync(join(ws, "infra/terraform.tfvars"), "keep = true\n");
    assert.equal(action(ws, { mode: "write" }).outputs.changed, "true");
    assert.equal(read(ws, "infra/variables.tf"), read(fixture, "infra/variables.tf"));
    assert.equal(read(ws, "infra/terraform.tfvars"), "keep = true\n");
  });
});

describe("signing", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = join(scratch, "trusted.pem");

  it("signs the receipt with the key, masks it, and the result verifies against the public key", async () => {
    writeFileSync(publicPem, publicKey.export({ type: "spki", format: "pem" }).toString());
    const ws = workspace();
    const result = action(ws, { "signing-key": pem });
    assert.equal(result.status, 0, result.stdout);
    assert.ok(existsSync(join(ws, "_diagram/receipt.json.sig")));
    assert.equal(JSON.parse(read(ws, "_diagram/receipt.json")).signed, true);
    const verdict = await verify([join(ws, "_diagram"), "--key", publicPem]);
    assert.equal(verdict.code, 0, verdict.stdout);
    assert.match(verdict.stdout, /detached:\s+pass/);

    const body = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
    const masked = result.stdout.split("\n").filter((l) => l.startsWith("::add-mask::"));
    for (const line of body) assert.ok(masked.includes(`::add-mask::${line}`), "every key line is masked");
    const visible = result.stdout
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    for (const line of body) assert.ok(!visible.includes(line), "the key appears nowhere else in the log");
    assert.ok(!read(ws, "_diagram/receipt.json").includes(body.join("")));
  });

  it("accepts the key base64-encoded, and rejects a key that is not Ed25519 without echoing it", () => {
    const encoded = Buffer.from(pem).toString("base64");
    assert.equal(action(workspace(), { "signing-key": encoded }).status, 0);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const rejected = action(workspace(), { "signing-key": rsa });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /signing-key must be an Ed25519 private key/);
    const garbage = action(workspace(), { "signing-key": "not a key at all" });
    assert.equal(garbage.status, 1);
    assert.match(garbage.stdout, /signing-key is not a private key in PEM/);
  });
});

describe("refusals and seams", () => {
  it("refuses to run under pull_request_target", () => {
    const ws = workspace();
    const result = action(ws, {}, { GITHUB_EVENT_NAME: "pull_request_target" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /must not run under pull_request_target/);
    assert.equal(existsSync(join(ws, "_diagram")), false, "nothing was done");
  });

  it("keeps the model and the directory inside the workspace, and rejects bad inputs", () => {
    for (const inputs of [{ model: "../diagram.json" }, { "terraform-dir": "/etc" }, { "terraform-dir": "../x" }]) {
      const result = action(workspace(), inputs);
      assert.equal(result.status, 1, JSON.stringify(inputs));
      assert.match(result.stdout, /is outside the workspace/);
    }
    assert.match(action(workspace(), { mode: "apply" }).stdout, /mode must be "check" or "write"/);
    assert.match(action(workspace(), { comment: "yes" }).stdout, /comment must be/);
  });

  it("never follows a symlink a pull request commits, for reads or writes", () => {
    const secret = join(scratch, `secret-${counter}.txt`);
    writeFileSync(secret, "RUNNER_SECRET_VALUE\n");

    // A Terraform file that points outside the workspace: not read into the diff.
    const file = workspace();
    rmSync(join(file, "infra/main.tf"));
    symlinkSync(secret, join(file, "infra/main.tf"));
    for (const mode of ["check", "write"]) {
      const result = action(file, { mode });
      assert.equal(result.status, 1, mode);
      assert.match(result.stdout, /refusing to follow the symlink/);
      assert.doesNotMatch(result.stdout, /RUNNER_SECRET_VALUE/);
    }
    assert.equal(readFileSync(secret, "utf8"), "RUNNER_SECRET_VALUE\n", "the target was not written");

    // The Terraform directory itself as a symlink.
    const dir = workspace();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    rmSync(join(dir, "infra"), { recursive: true });
    symlinkSync(elsewhere, join(dir, "infra"));
    assert.equal(action(dir, { mode: "write" }).status, 1);
    assert.equal(existsSync(join(elsewhere, "main.tf")), false, "nothing written through the link");

    // The model file as a symlink.
    const model = workspace();
    rmSync(join(model, "diagram.json"));
    symlinkSync(secret, join(model, "diagram.json"));
    const result = action(model);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /RUNNER_SECRET_VALUE/);
  });

  it("fails clearly on a missing, malformed or empty model", () => {
    const ws = workspace();
    assert.match(action(ws, { model: "nope.json" }).stdout, /cannot read the model file nope\.json/);
    writeFileSync(join(ws, "bad.json"), "{");
    assert.match(action(ws, { model: "bad.json" }).stdout, /bad\.json: it is not valid JSON/);
    writeFileSync(join(ws, "wrong.json"), '{"nodes": 3}');
    assert.match(action(ws, { model: "wrong.json" }).stdout, /not a diagram model/);
    writeFileSync(join(ws, "empty.json"), '{"nodes":[],"edges":[]}');
    assert.match(action(ws, { model: "empty.json" }).stdout, /has no components to build/);
  });

  it("accepts control-plane-url, says nothing was sent, and still passes", () => {
    const result = action(workspace(), { "control-plane-url": "https://control-plane.example/ingest" });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /::notice::control-plane-url is accepted, but uploading receipts is not yet supported/);
  });
});

/* ------------------------------------------------------------ pull request -- */

type Posted = { method: string; path: string; auth: string | undefined };

async function fakeGitHub(status = 200) {
  const comments: { id: number; body: string; user: { type: string } }[] = [];
  const seen: Posted[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as { body?: string }) : null;
      seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
      if (status !== 200 && req.method !== "GET") {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Resource not accessible by integration" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") {
        res.end(JSON.stringify(comments));
      } else if (req.method === "POST") {
        comments.push({ id: comments.length + 1, body: body?.body ?? "", user: { type: "Bot" } });
        res.end(JSON.stringify({ id: comments.length }));
      } else {
        const comment = comments.find((c) => req.url?.endsWith(`/${c.id}`));
        if (comment) comment.body = body?.body ?? "";
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, comments, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const git = (ws: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: ws,
    encoding: "utf8",
  }).trim();

/** A repository with the fixture committed as the base, then a pull request that swaps the cache for a queue. */
function pullRequest(): { ws: string; baseSha: string; headSha: string; event: string } {
  const ws = workspace();
  git(ws, "init", "-q");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "base");
  const baseSha = git(ws, "rev-parse", "HEAD");
  const model = JSON.parse(read(ws, "diagram.json")) as { nodes: { id: string }[]; edges: { target: string }[] };
  model.nodes = model.nodes.filter((n) => n.id !== "redis-cache");
  model.edges = model.edges.filter((e) => e.target !== "redis-cache");
  model.nodes.push({ id: "queue", category: "compute", kind: "queue", label: "Jobs queue", flag: null } as never);
  model.edges.push({ id: "app-queue", source: "app-service", target: "queue", origin: "user" } as never);
  writeFileSync(join(ws, "diagram.json"), `${JSON.stringify(model, null, 2)}\n`);
  assert.equal(action(ws, { mode: "write" }).status, 0);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "head");
  const headSha = git(ws, "rev-parse", "HEAD");
  const event = join(scratch, `event-${counter++}.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: baseSha }, head: { sha: headSha } } }));
  return { ws, baseSha, headSha, event };
}

type Fake = Awaited<ReturnType<typeof fakeGitHub>>;
type Pr = ReturnType<typeof pullRequest>;

function onPullRequest(gh: Fake, pr: Pr, inputs: Record<string, string> = { "github-token": "ghs_secret" }) {
  return actionAsync(pr.ws, inputs, {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: pr.event,
    GITHUB_REPOSITORY: "acme/infra",
    GITHUB_API_URL: gh.url,
  });
}

describe("on a pull request", () => {
  it("posts one sticky comment with the model diff, and updates it on the next run", async () => {
    const gh = await fakeGitHub();
    try {
      const pr = pullRequest();
      const first = await onPullRequest(gh, pr);
      assert.equal(first.status, 0, first.stdout);
      assert.equal(gh.comments.length, 1);
      const comment = gh.comments[0]?.body ?? "";
      assert.ok(comment.startsWith(COMMENT_MARKER));
      assert.match(comment, /```mermaid\nflowchart LR/);
      assert.match(comment, /class n\d+ added/);
      assert.match(comment, /class n\d+ removed/);
      assert.match(comment, /Jobs queue/);
      assert.match(comment, /\| Nodes \| 1 \| 1 \| 0 \|/);
      assert.ok(comment.includes(first.outputs["content-hash"] ?? "unreachable"));
      assert.match(comment, /`infra\/` matches `diagram\.json`/);
      assert.ok(gh.seen.every((s) => s.auth === "Bearer ghs_secret"));
      assert.equal(first.summary.includes(COMMENT_MARKER), false, "the step summary has no marker");
      assert.match(first.summary, /Model changes/);

      const second = await onPullRequest(gh, pr);
      assert.equal(second.status, 0, second.stdout);
      assert.equal(gh.comments.length, 1, "the same comment, not a second one");
      assert.equal(gh.seen.filter((s) => s.method === "PATCH").length, 1);
    } finally {
      await gh.close();
    }
  });

  it("comments and fails when the committed Terraform is behind the model", async () => {
    const gh = await fakeGitHub();
    try {
      const pr = pullRequest();
      writeFileSync(join(pr.ws, "infra/main.tf"), read(fixture, "infra/main.tf"));
      const result = await onPullRequest(gh, pr);
      assert.equal(result.status, 1);
      assert.equal(result.outputs.changed, "true");
      const comment = gh.comments[0]?.body ?? "";
      assert.match(comment, /`infra\/` differs from `diagram\.json` in \d+ files?\./);
      assert.match(comment, /```diff\n--- a\/infra\/main\.tf/);
    } finally {
      await gh.close();
    }
  });

  it("says the base is unavailable, instead of guessing, when the base commit is not in the checkout", async () => {
    const gh = await fakeGitHub();
    try {
      const pr = pullRequest();
      writeFileSync(
        pr.event,
        JSON.stringify({ pull_request: { number: 7, base: { sha: "0".repeat(40) }, head: { sha: pr.headSha } } }),
      );
      const result = await onPullRequest(gh, pr);
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, /::warning::the model could not be compared with the base/);
      assert.match(gh.comments[0]?.body ?? "", /fetch-depth: 0/);
      assert.doesNotMatch(gh.comments[0]?.body ?? "", /mermaid/);
    } finally {
      await gh.close();
    }
  });

  it("treats a model that is new in the pull request as all added", async () => {
    const gh = await fakeGitHub();
    try {
      const pr = pullRequest();
      git(pr.ws, "mv", "diagram.json", "model.json");
      git(pr.ws, "commit", "-q", "-m", "rename");
      const result = await onPullRequest(gh, pr, { "github-token": "t", model: "model.json" });
      assert.equal(result.status, 0, result.stdout);
      const comment = gh.comments[0]?.body ?? "";
      assert.match(comment, /`model\.json` is new in this pull request/);
      assert.match(comment, /\| Nodes \| 5 \| 0 \| 0 \|/);
    } finally {
      await gh.close();
    }
  });

  it("only warns when the comment is refused (a fork's read-only token): the check itself still decides", async () => {
    const gh = await fakeGitHub(403);
    try {
      const result = await onPullRequest(gh, pullRequest());
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, /::warning::the pull-request comment could not be posted: .*403.*pull-requests: write/);
      assert.doesNotMatch(result.stdout, /ghs_secret/);
    } finally {
      await gh.close();
    }
  });

  it("posts nothing with comment: false, or with no token, or outside a pull request", async () => {
    const gh = await fakeGitHub();
    try {
      const pr = pullRequest();
      const off = await onPullRequest(gh, pr, { "github-token": "t", comment: "false" });
      assert.equal(off.status, 0, off.stdout);
      const noToken = await onPullRequest(gh, pr, {});
      assert.match(noToken.stdout, /::warning::the pull-request comment was skipped/);
      const push = await actionAsync(pr.ws, { "github-token": "t" }, { GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: gh.url });
      assert.equal(push.status, 0);
      assert.equal(gh.seen.length, 0, "no request reached GitHub");
    } finally {
      await gh.close();
    }
  });
});
