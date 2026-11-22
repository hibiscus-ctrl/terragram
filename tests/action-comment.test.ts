// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMENT_MARKER, type CommentTarget, GitHubApiError, upsertStickyComment } from "../action/src/comment.ts";

/** The sticky comment against a fake GitHub: what it sends, and which comment it dares to edit. */

type Seen = { method: string; path: string; body: unknown; auth: string | null };
type Existing = { id: number; body: string; user: { type: string } };

function fakeGitHub(existing: Existing[][], failOn?: { method: string; status: number }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    seen.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    });
    if (failOn?.method === method) {
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: failOn.status });
    }
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(existing[page - 1] ?? []);
    }
    if (method === "PATCH") return Response.json({ id: 1 });
    return Response.json({ id: 999 }, { status: 201 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const target = (fetchImpl: typeof fetch): CommentTarget => ({
  fetch: fetchImpl,
  apiUrl: "https://api.github.test/",
  token: "ghs_token",
  repository: "acme/infra",
  issueNumber: 12,
});
const body = `${COMMENT_MARKER}\n## Diagram\n`;
const bot = (id: number, text = body): Existing => ({ id, body: text, user: { type: "Bot" } });

describe("upsertStickyComment", () => {
  it("creates the comment when there is none, with the token and the API headers", async () => {
    const gh = fakeGitHub([[{ id: 5, body: "looks good", user: { type: "User" } }]]);
    assert.deepEqual(await upsertStickyComment(target(gh.fetchImpl), body), { action: "created", id: 999 });
    assert.deepEqual(
      gh.seen.map((s) => `${s.method} ${s.path}`),
      ["GET /repos/acme/infra/issues/12/comments?per_page=100&page=1", "POST /repos/acme/infra/issues/12/comments"],
    );
    assert.equal(gh.seen[1]?.auth, "Bearer ghs_token");
    assert.deepEqual(gh.seen[1]?.body, { body });
  });

  it("updates its own earlier comment in place instead of adding another", async () => {
    const gh = fakeGitHub([[{ id: 5, body: "hi", user: { type: "User" } }, bot(7, `${COMMENT_MARKER}\nold`)]]);
    assert.deepEqual(await upsertStickyComment(target(gh.fetchImpl), body), { action: "updated", id: 7 });
    assert.equal(gh.seen.filter((s) => s.method === "POST").length, 0);
    assert.equal(gh.seen.at(-1)?.path, "/repos/acme/infra/issues/comments/7");
    assert.equal(gh.seen.at(-1)?.method, "PATCH");
  });

  it("never edits a comment a person wrote, even one that pastes the marker", async () => {
    const gh = fakeGitHub([[{ id: 8, body: `${COMMENT_MARKER}\nsneaky`, user: { type: "User" } }]]);
    assert.equal((await upsertStickyComment(target(gh.fetchImpl), body)).action, "created");
    assert.equal(gh.seen.filter((s) => s.method === "PATCH").length, 0);
  });

  it("looks past the first page of comments", async () => {
    const filler = Array.from({ length: 100 }, (_, i): Existing => ({ id: 100 + i, body: "chat", user: { type: "User" } }));
    const gh = fakeGitHub([filler, [bot(205)]]);
    assert.deepEqual(await upsertStickyComment(target(gh.fetchImpl), body), { action: "updated", id: 205 });
    assert.equal(gh.seen.filter((s) => s.method === "GET").length, 2);
  });

  it("cuts a body over GitHub's limit and refuses one without the marker", async () => {
    const gh = fakeGitHub([[]]);
    await upsertStickyComment(target(gh.fetchImpl), `${body}${"x".repeat(70_000)}`);
    const sent = (gh.seen.at(-1)?.body as { body: string } | undefined)?.body ?? "";
    assert.ok(sent.length < 65_536 && sent.startsWith(COMMENT_MARKER));
    await assert.rejects(upsertStickyComment(target(gh.fetchImpl), "no marker"), /marker/);
  });

  it("reports a refused write with its status and GitHub's reason, and never the token", async () => {
    const gh = fakeGitHub([[]], { method: "POST", status: 403 });
    await assert.rejects(upsertStickyComment(target(gh.fetchImpl), body), (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /403: Resource not accessible by integration/);
      assert.doesNotMatch(error.message, /ghs_token/);
      return true;
    });
  });
});
