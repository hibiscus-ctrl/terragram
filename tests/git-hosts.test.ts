import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitApiError, githubOpenPullRequest, githubRepositories } from "../src/features/git/github.ts";
import { gitlabOpenMergeRequest, gitlabProjects } from "../src/features/git/gitlab.ts";
import { authorizeUrl, exchangeCode, type ProviderConfig } from "../src/features/git/providers.ts";

/**
 * The host clients against a scripted fetch. What matters is the sequence and the
 * payloads: one commit, one branch, one change, and the right action per file.
 */

type Call = { method: string; url: string; body: unknown };

function scripted(routes: Array<[RegExp, (call: Call) => unknown, number?]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    for (const [pattern, reply, status] of routes) {
      if (pattern.test(`${call.method} ${url}`)) {
        return new Response(JSON.stringify(reply(call)), { status: status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ message: `unexpected ${call.method} ${url}` }), { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const FILES = [
  { path: "terraform/main.tf", content: "resource {}" },
  { path: "terraform/terragram-receipt.json", content: "{}" },
];

describe("github", () => {
  it("opens a pull request as one commit on a new branch off the default branch", async () => {
    let blobs = 0;
    const { fetchImpl, calls } = scripted([
      [/GET .*\/repos\/acme\/infra$/, () => ({ default_branch: "main" })],
      [/GET .*\/git\/ref\/heads\/main$/, () => ({ object: { sha: "base-sha" } })],
      [/GET .*\/git\/commits\/base-sha$/, () => ({ tree: { sha: "base-tree" } })],
      [/POST .*\/git\/blobs$/, () => ({ sha: `blob-${++blobs}` })],
      [/POST .*\/git\/trees$/, () => ({ sha: "new-tree" })],
      [/POST .*\/git\/commits$/, () => ({ sha: "new-commit" })],
      [/POST .*\/git\/refs$/, () => ({})],
      [/POST .*\/pulls$/, () => ({ html_url: "https://github.com/acme/infra/pull/7", number: 7 })],
    ]);

    const change = await githubOpenPullRequest({
      token: "t",
      apiUrl: "https://api.github.test",
      repository: "acme/infra",
      branch: "terragram/2026-09-11-abc",
      files: FILES,
      commitMessage: "Add plan",
      title: "Terragram: review",
      body: "body",
      fetchImpl,
    });

    assert.deepEqual(change, { url: "https://github.com/acme/infra/pull/7", number: 7, branch: "terragram/2026-09-11-abc" });
    const tree = calls.find((c) => c.url.endsWith("/git/trees"))?.body as { base_tree: string; tree: Array<{ path: string; sha: string }> };
    assert.equal(tree.base_tree, "base-tree");
    assert.deepEqual(tree.tree.map((t) => t.path), FILES.map((f) => f.path));
    const commit = calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST")?.body as { parents: string[] };
    assert.deepEqual(commit.parents, ["base-sha"]);
    const ref = calls.find((c) => c.url.endsWith("/git/refs"))?.body as { ref: string; sha: string };
    assert.deepEqual(ref, { ref: "refs/heads/terragram/2026-09-11-abc", sha: "new-commit" });
    const pull = calls.find((c) => c.url.endsWith("/pulls"))?.body as { head: string; base: string };
    assert.equal(pull.head, "terragram/2026-09-11-abc");
    assert.equal(pull.base, "main");
    assert.ok(calls.every((c) => c.url.startsWith("https://api.github.test/")));
  });

  it("surfaces the host's error with its status", async () => {
    const { fetchImpl } = scripted([[/GET .*\/repos\/acme\/infra$/, () => ({ message: "Not Found" }), 404]]);
    await assert.rejects(
      githubOpenPullRequest({
        token: "t",
        apiUrl: "https://api.github.test",
        repository: "acme/infra",
        branch: "b",
        files: FILES,
        commitMessage: "m",
        title: "t",
        body: "b",
        fetchImpl,
      }),
      (err: unknown) => err instanceof GitApiError && err.status === 404 && /Not Found/.test(err.message),
    );
  });

  it("lists only repositories the user can push to", async () => {
    const { fetchImpl } = scripted([
      [
        /GET .*\/user\/repos/,
        () => [
          { full_name: "acme/infra", default_branch: "main", private: true, permissions: { push: true } },
          { full_name: "acme/docs", default_branch: "main", private: false, permissions: { push: false } },
        ],
      ],
    ]);
    const repos = await githubRepositories("t", "https://api.github.test", fetchImpl);
    assert.deepEqual(repos, [{ fullName: "acme/infra", defaultBranch: "main", private: true }]);
  });
});

describe("gitlab", () => {
  it("opens a merge request with create for new files and update for existing ones", async () => {
    const { fetchImpl, calls } = scripted([
      [/GET .*\/projects\/42$/, () => ({ default_branch: "main" })],
      [/GET .*\/projects\/42\/repository\/tree/, () => [{ path: "terraform/main.tf", type: "blob" }]],
      [/POST .*\/projects\/42\/repository\/commits$/, () => ({ id: "c1" })],
      [/POST .*\/projects\/42\/merge_requests$/, () => ({ web_url: "https://gitlab.test/acme/infra/-/merge_requests/3", iid: 3 })],
    ]);

    const change = await gitlabOpenMergeRequest({
      token: "t",
      apiUrl: "https://gitlab.test/api/v4",
      projectId: 42,
      branch: "terragram/2026-09-11-abc",
      files: FILES,
      commitMessage: "Add plan",
      title: "Terragram: review",
      body: "body",
      fetchImpl,
    });

    assert.equal(change.number, 3);
    const commit = calls.find((c) => c.url.endsWith("/repository/commits"))?.body as {
      branch: string;
      start_branch: string;
      actions: Array<{ action: string; file_path: string }>;
    };
    assert.equal(commit.start_branch, "main");
    assert.deepEqual(
      commit.actions.map((a) => [a.action, a.file_path]),
      [
        ["update", "terraform/main.tf"],
        ["create", "terraform/terragram-receipt.json"],
      ],
    );
    const mr = calls.find((c) => c.url.endsWith("/merge_requests"))?.body as { source_branch: string; target_branch: string };
    assert.deepEqual(mr, { ...mr, source_branch: "terragram/2026-09-11-abc", target_branch: "main" });
  });

  it("treats a missing directory as empty rather than failing", async () => {
    const { fetchImpl, calls } = scripted([
      [/GET .*\/projects\/42$/, () => ({ default_branch: "main" })],
      [/GET .*\/projects\/42\/repository\/tree/, () => ({ message: "404 Tree Not Found" }), 404],
      [/POST .*\/projects\/42\/repository\/commits$/, () => ({ id: "c1" })],
      [/POST .*\/projects\/42\/merge_requests$/, () => ({ web_url: "u", iid: 1 })],
    ]);
    await gitlabOpenMergeRequest({
      token: "t",
      apiUrl: "https://gitlab.test/api/v4",
      projectId: 42,
      branch: "b",
      files: FILES,
      commitMessage: "m",
      title: "t",
      body: "b",
      fetchImpl,
    });
    const commit = calls.find((c) => c.url.endsWith("/repository/commits"))?.body as { actions: Array<{ action: string }> };
    assert.ok(commit.actions.every((a) => a.action === "create"));
  });

  it("lists projects with a default branch", async () => {
    const { fetchImpl } = scripted([
      [
        /GET .*\/projects\?/,
        () => [
          { id: 1, path_with_namespace: "acme/infra", default_branch: "main" },
          { id: 2, path_with_namespace: "acme/empty", default_branch: null },
        ],
      ],
    ]);
    const projects = await gitlabProjects("t", "https://gitlab.test/api/v4", fetchImpl);
    assert.deepEqual(projects, [{ id: 1, pathWithNamespace: "acme/infra", defaultBranch: "main" }]);
  });
});

describe("oauth", () => {
  const config: ProviderConfig = {
    provider: "github",
    clientId: "id",
    clientSecret: "secret",
    authorizeUrl: "https://github.test/login/oauth/authorize",
    tokenUrl: "https://github.test/login/oauth/access_token",
    apiUrl: "https://api.github.test",
    scope: "",
  };

  it("builds the authorization URL with state and redirect, omitting an empty scope", () => {
    const url = new URL(authorizeUrl(config, "github.abc", "https://terragram.test/api/git/github/callback"));
    assert.equal(url.searchParams.get("client_id"), "id");
    assert.equal(url.searchParams.get("state"), "github.abc");
    assert.equal(url.searchParams.get("redirect_uri"), "https://terragram.test/api/git/github/callback");
    assert.equal(url.searchParams.has("scope"), false);
  });

  it("exchanges a code and computes the expiry from expires_in", async () => {
    const { fetchImpl, calls } = scripted([
      [/POST .*\/access_token$/, () => ({ access_token: "ghu_x", refresh_token: "ghr_y", expires_in: 3600 })],
    ]);
    const token = await exchangeCode(config, "code-1", "https://terragram.test/cb", fetchImpl, Date.parse("2026-09-11T00:00:00Z"));
    assert.deepEqual(token, { accessToken: "ghu_x", refreshToken: "ghr_y", expiresAt: "2026-09-11T01:00:00.000Z" });
    const sent = calls[0]?.body as { code: string; client_secret: string; grant_type: string };
    assert.equal(sent.code, "code-1");
    assert.equal(sent.client_secret, "secret");
    assert.equal(sent.grant_type, "authorization_code");
  });

  it("fails loudly when the host returns no token", async () => {
    const { fetchImpl } = scripted([[/POST .*\/access_token$/, () => ({ error: "bad_verification_code" })]]);
    await assert.rejects(exchangeCode(config, "x", "cb", fetchImpl), /bad_verification_code/);
  });
});
