// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { GitApiError, type OpenedChange } from "./github.ts";
import type { ChangeFile } from "./pr.ts";

/**
 * GitLab, mirroring the GitHub flow through the v4 API.
 *
 * GitLab's commits endpoint takes every file action in one request, which is the
 * single-commit guarantee the GitHub path builds by hand. The one wrinkle is that
 * `create` refuses a path that already exists and `update` refuses one that does
 * not, so the base branch's tree is read first to pick the right action per file.
 */

export type Project = {
  id: number;
  /** `group/name` */
  pathWithNamespace: string;
  defaultBranch: string;
};

type Ctx = { token: string; apiUrl: string; fetchImpl: typeof fetch };

async function call<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const response = await ctx.fetchImpl(`${ctx.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof detail?.message === "string" ? detail.message : JSON.stringify(detail?.message ?? "");
    throw new GitApiError(response.status, message || `GitLab ${method} ${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function gitlabAccountLogin(token: string, apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const user = await call<{ username: string }>({ token, apiUrl, fetchImpl }, "GET", "/user");
  return user.username;
}

/** Projects the user can push to (Developer and above), most recently active first. */
export async function gitlabProjects(
  token: string,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Project[]> {
  type Row = { id: number; path_with_namespace: string; default_branch: string | null };
  const rows = await call<Row[]>(
    { token, apiUrl, fetchImpl },
    "GET",
    "/projects?membership=true&min_access_level=30&per_page=100&order_by=last_activity_at",
  );
  return rows
    .filter((r) => r.default_branch)
    .map((r) => ({ id: r.id, pathWithNamespace: r.path_with_namespace, defaultBranch: r.default_branch as string }));
}

export async function gitlabOpenMergeRequest(args: {
  token: string;
  apiUrl: string;
  projectId: number;
  branch: string;
  files: ChangeFile[];
  commitMessage: string;
  title: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenedChange> {
  const ctx: Ctx = { token: args.token, apiUrl: args.apiUrl, fetchImpl: args.fetchImpl ?? fetch };
  const project = `/projects/${args.projectId}`;

  const meta = await call<{ default_branch: string }>(ctx, "GET", project);
  const base = meta.default_branch;

  // Which of our paths already exist on base decides create vs update per file.
  const directory = args.files[0]?.path.includes("/") ? args.files[0].path.slice(0, args.files[0].path.lastIndexOf("/")) : "";
  const existing = await call<Array<{ path: string; type: string }>>(
    ctx,
    "GET",
    `${project}/repository/tree?ref=${encodeURIComponent(base)}&per_page=100${directory ? `&path=${encodeURIComponent(directory)}` : ""}`,
  ).catch((err: unknown) => {
    // A missing directory is an empty listing, not a failure.
    if (err instanceof GitApiError && err.status === 404) return [];
    throw err;
  });
  const present = new Set(existing.filter((e) => e.type === "blob").map((e) => e.path));

  await call(ctx, "POST", `${project}/repository/commits`, {
    branch: args.branch,
    start_branch: base,
    commit_message: args.commitMessage,
    actions: args.files.map((f) => ({
      action: present.has(f.path) ? "update" : "create",
      file_path: f.path,
      content: f.content,
    })),
  });

  const mr = await call<{ web_url: string; iid: number }>(ctx, "POST", `${project}/merge_requests`, {
    source_branch: args.branch,
    target_branch: base,
    title: args.title,
    description: args.body,
    remove_source_branch: true,
  });
  return { url: mr.web_url, number: mr.iid, branch: args.branch };
}
