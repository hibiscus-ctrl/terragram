// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one sticky pull-request comment, found by an HTML marker and updated in place.
 *
 * Only a comment written by a bot account is ever updated: anyone who can comment on a
 * public pull request could otherwise paste the marker and have the Action edit their
 * text instead of its own. A repository token's comments are authored by a bot
 * (`github-actions[bot]`), so that is also what finds our previous one.
 */

export const COMMENT_MARKER = "<!-- terragram-action:sticky -->";

/** GitHub rejects a comment body over 65,536 characters. */
const MAX_BODY = 65_000;
const PAGE = 100;
const MAX_PAGES = 20;

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Comment = { id: number; body?: string | null; user?: { type?: string } | null };

export type CommentTarget = {
  fetch: typeof fetch;
  /** `GITHUB_API_URL`, e.g. https://api.github.com */
  apiUrl: string;
  token: string;
  /** `owner/name` */
  repository: string;
  issueNumber: number;
};

async function call(target: CommentTarget, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await target.fetch(`${target.apiUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${target.token}`,
      "content-type": "application/json",
      "user-agent": "terragram-action",
      "x-github-api-version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = ((await response.json()) as { message?: string }).message ?? "";
    } catch {
      // A non-JSON error body adds nothing the status does not say.
    }
    throw new GitHubApiError(`${method} ${path} answered ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
  }
  return response.status === 204 ? null : response.json();
}

async function findOurs(target: CommentTarget): Promise<Comment | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/repos/${target.repository}/issues/${target.issueNumber}/comments?per_page=${PAGE}&page=${page}`;
    const comments = (await call(target, "GET", path)) as Comment[];
    const ours = comments.find((c) => c.user?.type === "Bot" && c.body?.includes(COMMENT_MARKER));
    if (ours) return ours;
    if (comments.length < PAGE) return null;
  }
  return null;
}

/** Create the comment, or update the one this Action posted before. `body` must carry the marker. */
export async function upsertStickyComment(
  target: CommentTarget,
  body: string,
): Promise<{ action: "created" | "updated"; id: number }> {
  if (!body.includes(COMMENT_MARKER)) throw new Error("the comment body does not carry the marker");
  const text = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n(truncated)\n` : body;
  const existing = await findOurs(target);
  if (existing) {
    await call(target, "PATCH", `/repos/${target.repository}/issues/comments/${existing.id}`, { body: text });
    return { action: "updated", id: existing.id };
  }
  const created = (await call(target, "POST", `/repos/${target.repository}/issues/${target.issueNumber}/comments`, {
    body: text,
  })) as { id: number };
  return { action: "created", id: created.id };
}
