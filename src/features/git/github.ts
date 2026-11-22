import type { ChangeFile } from "./pr.ts";

/**
 * GitHub, through the REST API with a user-to-server token.
 *
 * A change is built with the Git Data API — blobs, a tree on top of the base
 * commit's tree, a commit, a ref — rather than the contents endpoint, so every
 * file lands in one commit and the branch is exactly one commit ahead of base.
 * Every call goes through `fetchImpl`, so the whole sequence is testable against a
 * scripted fake.
 */

export class GitApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitApiError";
    this.status = status;
  }
}

export type Repository = {
  /** `owner/name` */
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type OpenedChange = { url: string; number: number; branch: string };

type Ctx = { token: string; apiUrl: string; fetchImpl: typeof fetch };

async function call<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const response = await ctx.fetchImpl(`${ctx.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new GitApiError(response.status, detail?.message ?? `GitHub ${method} ${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function githubAccountLogin(token: string, apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const user = await call<{ login: string }>({ token, apiUrl, fetchImpl }, "GET", "/user");
  return user.login;
}

/** Repositories the user can push to, most recently pushed first. */
export async function githubRepositories(
  token: string,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Repository[]> {
  type Row = { full_name: string; default_branch: string; private: boolean; permissions?: { push?: boolean } };
  const rows = await call<Row[]>(
    { token, apiUrl, fetchImpl },
    "GET",
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  );
  return rows
    .filter((r) => r.permissions?.push !== false)
    .map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private }));
}

export async function githubOpenPullRequest(args: {
  token: string;
  apiUrl: string;
  repository: string;
  branch: string;
  files: ChangeFile[];
  commitMessage: string;
  title: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenedChange> {
  const ctx: Ctx = { token: args.token, apiUrl: args.apiUrl, fetchImpl: args.fetchImpl ?? fetch };
  const repo = `/repos/${args.repository}`;

  const meta = await call<{ default_branch: string }>(ctx, "GET", repo);
  const base = meta.default_branch;
  const ref = await call<{ object: { sha: string } }>(ctx, "GET", `${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = ref.object.sha;
  const baseCommit = await call<{ tree: { sha: string } }>(ctx, "GET", `${repo}/git/commits/${baseSha}`);

  const tree = [];
  for (const file of args.files) {
    const blob = await call<{ sha: string }>(ctx, "POST", `${repo}/git/blobs`, {
      content: file.content,
      encoding: "utf-8",
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await call<{ sha: string }>(ctx, "POST", `${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree,
  });
  const commit = await call<{ sha: string }>(ctx, "POST", `${repo}/git/commits`, {
    message: args.commitMessage,
    tree: newTree.sha,
    parents: [baseSha],
  });
  await call(ctx, "POST", `${repo}/git/refs`, { ref: `refs/heads/${args.branch}`, sha: commit.sha });

  const pull = await call<{ html_url: string; number: number }>(ctx, "POST", `${repo}/pulls`, {
    title: args.title,
    head: args.branch,
    base,
    body: args.body,
  });
  return { url: pull.html_url, number: pull.number, branch: args.branch };
}
