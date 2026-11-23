// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { Ajv2020 } from "ajv/dist/2020.js";

import { run as terragram } from "../packages/cli/src/cli.ts";
import type { Io } from "../packages/cli/src/io.ts";

/**
 * The built Action uploading its bundle, run the way the runner runs it, against a local fake of
 * GitHub's identity-token endpoint and of the control plane's session and ingest routes. What is
 * pinned: the exchange the control plane expects (identity token in `X-GitHub-OIDC-Token`, then the
 * run token as the bearer), that what is sent is the bundle the Action wrote and verifies with a key
 * from outside it, that neither token is ever printed, and that every failure fails the step with the
 * reason the control plane gave.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "tests/fixtures/action");
const scratch = mkdtempSync(join(tmpdir(), "terragram-action-upload-"));
const bundle = join(scratch, "index.mjs");
after(() => rmSync(scratch, { recursive: true, force: true }));

before(() => {
  execFileSync(process.execPath, [join(root, "action/build.mjs"), "--outfile", bundle], { cwd: root, stdio: "pipe" });
});

let counter = 0;
function workspace(): string {
  const dir = join(scratch, `ws-${counter++}`);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

type Outcome = { status: number; stdout: string; outputs: Record<string, string> };

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

/** Asynchronous, so the fake server in this process can answer while the Action runs. */
function runAction(ws: string, inputs: Record<string, string>, extra: Record<string, string>): Promise<Outcome> {
  const outFile = join(ws, "..", `out-${counter++}`);
  writeFileSync(outFile, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GITHUB_WORKSPACE: ws,
    GITHUB_OUTPUT: outFile,
    GITHUB_EVENT_NAME: "push",
    ...extra,
  };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  return new Promise((resolve) => {
    execFile(process.execPath, [bundle], { cwd: ws, env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({
        status: error ? ((error as { code?: number }).code ?? 1) : 0,
        stdout: `${stdout}${stderr}`,
        outputs: parseOutputs(readFileSync(outFile, "utf8")),
      });
    });
  });
}

const read = (ws: string, ...parts: string[]) => readFileSync(join(ws, ...parts), "utf8");

function verify(args: string[]): Promise<number> {
  const io: Io = { out: () => undefined, err: () => undefined, cwd: scratch };
  return terragram(["verify", ...args], io);
}

type Seen = { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: Buffer };
type Reply = { status: number; body: unknown };
type Plan = Partial<Record<"oidc" | "session" | "ingest", Reply[]>>;

/** Each route answers from its list, one entry per attempt (the last repeats); every request is recorded. */
async function fakeControlPlane(plan: Plan = {}) {
  const seen: Seen[] = [];
  const replies = {
    oidc: plan.oidc ?? [{ status: 200, body: { value: "oidc-secret-jwt" } }],
    session: plan.session ?? [{ status: 200, body: { token: "run-secret-token", expires_at: "2026-11-22T12:00:00Z" } }],
    ingest: plan.ingest ?? [{ status: 201, body: { stored: true, replayed: false, snapshot_id: "snap-1", workspace_id: "ws-1" } }],
  };
  const answered = { oidc: 0, session: 0, ingest: 0 };
  const routes: Record<string, keyof typeof replies> = {
    "/oidc": "oidc",
    "/api/v1/session": "session",
    "/api/v1/ingest/diagram": "ingest",
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({ method: req.method ?? "", path: url.pathname + url.search, headers: req.headers, body: Buffer.concat(chunks) });
      const route = routes[url.pathname];
      const list = route ? replies[route] : [];
      const reply = route ? list[Math.min(answered[route]++, list.length - 1)] : undefined;
      res.writeHead(reply?.status ?? 404, { "content-type": "application/json" });
      res.end(JSON.stringify(reply?.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    count: (path: string) => seen.filter((r) => r.path.split("?")[0] === path).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Plane = Awaited<ReturnType<typeof fakeControlPlane>>;

/** What the runner sets for a job with `id-token: write`, pointed at the fake. */
const runnerEnv = (plane: Plane, extra: Record<string, string> = {}) => ({
  ACTIONS_ID_TOKEN_REQUEST_URL: `${plane.url}/oidc?api-version=2.0`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
  GITHUB_SHA: "a".repeat(40),
  ...extra,
});

/** Run the Action against a fake with `plan`, close the fake, and hand back both. */
async function withPlane<T>(plan: Plan, body: (plane: Plane) => Promise<T>): Promise<T> {
  const plane = await fakeControlPlane(plan);
  try {
    return await body(plane);
  } finally {
    await plane.close();
  }
}

type Sent = { schema: string; model_path: string; sha?: string; entries: { name: string; content: string }[] };
function sentDocument(plane: Plane): { request: Seen; document: Sent } {
  const request = plane.seen.find((r) => r.path === "/api/v1/ingest/diagram");
  assert.ok(request, "the bundle was sent");
  return { request, document: JSON.parse(gunzipSync(request.body).toString("utf8")) as Sent };
}

describe("uploading the bundle", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const trusted = join(scratch, "trusted.pem");
  writeFileSync(trusted, publicKey.export({ type: "spki", format: "pem" }).toString());

  it("trades the identity token for a run token and sends the bundle, which verifies from what was sent", () =>
    withPlane({}, async (plane) => {
      const ws = workspace();
      const result = await runAction(ws, { "control-plane-url": plane.url, "signing-key": pem }, runnerEnv(plane));
      assert.equal(result.status, 0, result.stdout);

      assert.deepEqual(
        plane.seen.map((r) => `${r.method} ${r.path.split("?")[0]}`),
        ["GET /oidc", "POST /api/v1/session", "POST /api/v1/ingest/diagram"],
      );
      const [oidc, session, ingest] = plane.seen;
      assert.equal(oidc?.headers.authorization, "Bearer request-secret");
      assert.match(oidc?.path ?? "", /audience=infraharvest-api/);
      assert.match(oidc?.path ?? "", /api-version=2\.0/, "the runner's own query is kept");
      assert.equal(session?.headers["x-github-oidc-token"], "oidc-secret-jwt");
      assert.equal(ingest?.headers.authorization, "Bearer run-secret-token");
      assert.equal(ingest?.headers["content-encoding"], "gzip");
      assert.equal(ingest?.headers["content-type"], "application/json");

      const { document } = sentDocument(plane);
      assert.equal(document.schema, "diagram.bundle/v1");
      assert.equal(document.model_path, "diagram.json");
      assert.equal(document.sha, "a".repeat(40));
      assert.deepEqual(document.entries.map((e) => e.name).sort(), [
        "explanation.txt",
        "model.json",
        "plan/main.tf",
        "plan/outputs.tf",
        "plan/variables.tf",
        "receipt.json",
        "receipt.json.sig",
        "signing-key.pem",
      ]);
      // What was sent is the bundle the Action wrote, and it verifies against a key from outside it.
      const received = join(scratch, `received-${counter++}`);
      for (const entry of document.entries) {
        assert.equal(entry.content, read(ws, "_diagram", entry.name));
        mkdirSync(dirname(join(received, entry.name)), { recursive: true });
        writeFileSync(join(received, entry.name), entry.content);
      }
      assert.equal(await verify([received, "--key", trusted]), 0);

      assert.equal(result.outputs["snapshot-id"], "snap-1");
      assert.match(result.stdout, /uploaded the bundle: snapshot snap-1/);
    }));

  it("masks both tokens before anything is printed, and prints neither", () =>
    withPlane({}, async (plane) => {
      const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
      assert.equal(result.status, 0, result.stdout);
      const lines = result.stdout.split("\n");
      for (const secret of ["oidc-secret-jwt", "run-secret-token"]) {
        assert.ok(lines.includes(`::add-mask::${secret}`), `${secret} is masked`);
        assert.equal(
          lines.filter((line) => !line.startsWith("::add-mask::")).some((line) => line.includes(secret)),
          false,
          `${secret} is never printed`,
        );
      }
      assert.equal(result.stdout.includes("request-secret"), false);
    }));

  it("uploads an unsigned bundle too, with the model's path from the repository root", () =>
    withPlane({}, async (plane) => {
      const ws = workspace();
      mkdirSync(join(ws, "sub"), { recursive: true });
      cpSync(join(ws, "diagram.json"), join(ws, "sub/diagram.json"));
      const result = await runAction(ws, { "control-plane-url": plane.url, model: "sub/diagram.json" }, runnerEnv(plane));
      assert.equal(result.status, 0, result.stdout);
      const { document } = sentDocument(plane);
      assert.equal(document.model_path, "sub/diagram.json");
      assert.equal(
        document.entries.some((e) => e.name === "receipt.json.sig"),
        false,
      );
    }));

  it("says so when the control plane already had the bundle", () =>
    withPlane(
      { ingest: [{ status: 200, body: { stored: true, replayed: true, snapshot_id: "snap-0", workspace_id: "ws-1" } }] },
      async (plane) => {
        const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
        assert.equal(result.status, 0, result.stdout);
        assert.match(result.stdout, /the control plane already had this bundle: snapshot snap-0/);
      },
    ));

  it("asks GitHub for the audience the input names", () =>
    withPlane({}, async (plane) => {
      await runAction(workspace(), { "control-plane-url": plane.url, "control-plane-audience": "my-audience" }, runnerEnv(plane));
      assert.match(plane.seen[0]?.path ?? "", /audience=my-audience/);
    }));

  it("keeps a path prefix on the address", () =>
    withPlane({}, async (plane) => {
      // The fake answers only at the root, so a prefix is a 404 from the session route: the request path shows it was kept.
      const result = await runAction(workspace(), { "control-plane-url": `${plane.url}/cloud/` }, runnerEnv(plane));
      assert.equal(result.status, 1);
      assert.ok(plane.seen.some((r) => r.path === "/cloud/api/v1/session"));
    }));

  it("fails clearly, sending nothing, when the job has no identity token (id-token: write is missing)", () =>
    withPlane({}, async (plane) => {
      const ws = workspace();
      const result = await runAction(ws, { "control-plane-url": plane.url }, {});
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error::.*id-token: write/);
      assert.equal(plane.seen.length, 0);
      assert.ok(existsSync(join(ws, "_diagram/receipt.json")), "the receipt is still written");
    }));

  const refusals: [string, Plan, RegExp][] = [
    ["GitHub refuses the identity token", { oidc: [{ status: 403, body: {} }] }, /would not issue an identity token for the audience "infraharvest-api" \(status 403\)/],
    [
      "the control plane does not know the repository's owner",
      { session: [{ status: 403, body: { error: 'No active GitHub App installation for "acme"' } }] },
      /refused the job's identity \(status 403\): No active GitHub App installation/,
    ],
    [
      "the control plane rejects the bundle",
      { ingest: [{ status: 422, body: { error: "Invalid diagram bundle: the content hash does not check" } }] },
      /did not keep the bundle \(status 422\): Invalid diagram bundle: the content hash does not check/,
    ],
    [
      "the plan does not keep uploads",
      { ingest: [{ status: 402, body: { error: "Keeping uploaded diagram approvals is part of the hosted evidence plan" } }] },
      /status 402\): Keeping uploaded.*\(keeping uploaded approvals is part of the hosted evidence plan\)/,
    ],
    [
      "the token is not a repository's",
      { ingest: [{ status: 403, body: { error: "A diagram bundle must come from a repository" } }] },
      /status 403\): A diagram bundle must come from a repository.*run token/,
    ],
    ["the session answer has no token", { session: [{ status: 200, body: {} }] }, /carried no token/],
    ["the ingest answer does not say what was kept", { ingest: [{ status: 200, body: { persisted: true } }] }, /without saying what it kept/],
    ["the control plane's reason holds control characters", { ingest: [{ status: 422, body: { error: "bad\n::error::injected" } }] }, /\(status 422\): bad ::error::injected/],
  ];
  for (const [name, plan, expected] of refusals) {
    it(`fails the step with the reason when ${name}`, () =>
      withPlane(plan, async (plane) => {
        const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stdout, expected);
        assert.equal(result.outputs["snapshot-id"], undefined);
      }));
  }

  it("keeps a refusal's text on one line, so it cannot start a workflow command of its own", () =>
    withPlane({ ingest: [{ status: 422, body: { error: "bad\n::error::injected" } }] }, async (plane) => {
      const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
      assert.equal(result.stdout.split("\n").some((line) => line.startsWith("::error::injected")), false);
    }));

  it("tries again after a 503 and succeeds", () =>
    withPlane(
      { ingest: [{ status: 503, body: {} }, { status: 201, body: { snapshot_id: "snap-2", workspace_id: "ws-1" } }] },
      async (plane) => {
        const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
        assert.equal(result.status, 0, result.stdout);
        assert.match(result.stdout, /ingest endpoint answered 503; trying again/);
        assert.equal(plane.count("/api/v1/ingest/diagram"), 2);
        assert.equal(result.outputs["snapshot-id"], "snap-2");
      },
    ));

  it("gives up after three attempts, saying what it kept getting", () =>
    withPlane({ session: [{ status: 502, body: {} }] }, async (plane) => {
      const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
      assert.equal(result.status, 1);
      assert.equal(plane.count("/api/v1/session"), 3);
      assert.equal(plane.count("/api/v1/ingest/diagram"), 0);
      assert.match(result.stdout, /::error::the control plane refused the job's identity \(status 502\)/);
    }));

  it("does not try again after a refusal", () =>
    withPlane({ ingest: [{ status: 422, body: { error: "no" } }] }, async (plane) => {
      await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane));
      assert.equal(plane.count("/api/v1/ingest/diagram"), 1);
    }));

  it("does not follow a redirect with the token on it", async () => {
    const target = await fakeControlPlane();
    const redirecting = createServer((_req, res) => {
      res.writeHead(307, { location: `${target.url}/api/v1/session` });
      res.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
      const result = await runAction(
        workspace(),
        { "control-plane-url": url },
        { ACTIONS_ID_TOKEN_REQUEST_URL: `${target.url}/oidc`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret" },
      );
      assert.equal(result.status, 1);
      assert.equal(target.count("/api/v1/session"), 0, "the identity token never reached the redirect's target");
    } finally {
      await new Promise<void>((resolve) => redirecting.close(() => resolve()));
      await target.close();
    }
  });

  it("refuses an address that is not https (a machine's own loopback aside), or has credentials or a query, before any request", async () => {
    const urls = ["http://control-plane.example", "ftp://control-plane.example", "not a url", "https://user:pw@control-plane.example", "https://control-plane.example/?q=1"];
    for (const url of urls) {
      const result = await runAction(
        workspace(),
        { "control-plane-url": url },
        { ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:1/oidc", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" },
      );
      assert.equal(result.status, 1, url);
      assert.match(result.stdout, /::error::control-plane-url/, url);
    }
  });

  it("reports drift and a failed upload together, and fails for either", () =>
    withPlane({ ingest: [{ status: 422, body: { error: "no" } }] }, async (plane) => {
      const ws = workspace();
      writeFileSync(join(ws, "infra/main.tf"), `${read(ws, "infra/main.tf")}\n# drift\n`);
      const result = await runAction(ws, { "control-plane-url": plane.url }, runnerEnv(plane));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error file=infra\/main\.tf::/);
      assert.match(result.stdout, /did not keep the bundle/);
    }));

  it("uploads from a push even when the Terraform has drifted, since the receipt covers the model", () =>
    withPlane({}, async (plane) => {
      const ws = workspace();
      writeFileSync(join(ws, "infra/main.tf"), `${read(ws, "infra/main.tf")}\n# drift\n`);
      const result = await runAction(ws, { "control-plane-url": plane.url }, runnerEnv(plane));
      assert.equal(result.status, 1);
      assert.equal(plane.count("/api/v1/ingest/diagram"), 1);
    }));

  for (const event of ["workflow_dispatch", "workflow_run", "schedule", "issue_comment", "merge_group", "release", ""]) {
    it(`uploads nothing from a ${event || "run with no event"}, and says why`, () =>
      withPlane({}, async (plane) => {
        const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane, { GITHUB_EVENT_NAME: event }));
        assert.equal(result.status, 0, result.stdout);
        assert.match(result.stdout, /::notice::the bundle was not uploaded: it is uploaded only from a push/);
        assert.equal(plane.seen.length, 0);
        assert.equal(result.outputs["snapshot-id"], undefined);
      }));
  }

  it("sends a document that validates against schemas/diagram-bundle-v1.schema.json", () =>
    withPlane({}, async (plane) => {
      const result = await runAction(workspace(), { "control-plane-url": plane.url, "signing-key": pem }, runnerEnv(plane));
      assert.equal(result.status, 0, result.stdout);
      const { document } = sentDocument(plane);
      const schema = JSON.parse(readFileSync(join(root, "schemas/diagram-bundle-v1.schema.json"), "utf8")) as object;
      const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
      assert.equal(validate(document), true, JSON.stringify(validate.errors));
      assert.equal(new Set(document.entries.map((e) => e.name)).size, document.entries.length, "entry names are unique");

      // The schema is not vacuous: it refuses what the receiver refuses.
      const broken: unknown[] = [
        { ...document, schema: "diagram.bundle/v2" },
        { ...document, model_path: "" },
        { ...document, sha: "NOT-A-SHA" },
        { ...document, entries: document.entries.slice(0, 1) },
        { ...document, entries: Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, content: "" })) },
        { ...document, entries: [{ name: "a" }, { name: "b", content: "" }] },
        { schema: document.schema, entries: document.entries },
      ];
      for (const candidate of broken) assert.equal(validate(candidate), false, JSON.stringify(candidate).slice(0, 80));
    }));

  it("uploads nothing from a pull request, and says why", () =>
    withPlane({}, async (plane) => {
      const result = await runAction(workspace(), { "control-plane-url": plane.url }, runnerEnv(plane, { GITHUB_EVENT_NAME: "pull_request" }));
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, /::notice::the bundle was not uploaded: a pull request's model is not approved yet/);
      assert.equal(plane.seen.length, 0);
    }));

  it("sends nothing at all without control-plane-url", () =>
    withPlane({}, async (plane) => {
      const result = await runAction(workspace(), {}, runnerEnv(plane));
      assert.equal(result.status, 0, result.stdout);
      assert.equal(plane.seen.length, 0);
      assert.equal(result.outputs["snapshot-id"], undefined);
    }));
});
