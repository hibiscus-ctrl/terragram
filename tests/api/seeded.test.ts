// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signed-in contracts: real users, real sessions, real rows.
 *
 * Three throwaway users (`owner`, `other`, `flood`) are created, signed in
 * through /auth/confirm and deleted in `after()` with everything their sign-in
 * provisioned. Rows are `terragram_*` only. The test server runs with
 * WORKSPACE_ENGINE blank (.env.test), so every translate is the deterministic
 * engine — no managed model is ever called and nothing is metered.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { api, CONFIGURED, REDIRECT, SITE_ORIGIN, warmPageRoutes } from "./helpers/client.ts";
import { Fixture, type Persona } from "./helpers/personas.ts";
import { adminClient, CAN_SEED, seedShareLink, seedWorkspace } from "./helpers/seed.ts";
import { assertApiError, assertRateLimited, assertSameOriginRedirect } from "./helpers/shape.ts";

const SEEDABLE = CONFIGURED && CAN_SEED;
const NAME = `apitest-terragram-ws-${randomBytes(4).toString("hex")}`;

let fixture: Fixture;
let owner: Persona;
let other: Persona;
let flood: Persona;
let workspaceId = "";
const links = { live: "", revoked: "", expired: "" };

describe("signed-in contracts", { skip: !SEEDABLE, concurrency: false }, () => {
  before(async () => {
    await warmPageRoutes(["/workspace", "/workspace/canvas", "/billing", "/login", "/shared/warm"]);
    fixture = new Fixture(adminClient());
    owner = await fixture.persona("owner");
    other = await fixture.persona("other");
    flood = await fixture.persona("flood");
    workspaceId = await seedWorkspace(fixture.admin, owner.userId, NAME);
    links.live = await seedShareLink(fixture.admin, owner.userId, workspaceId, "live");
    links.revoked = await seedShareLink(fixture.admin, owner.userId, workspaceId, "revoked");
    links.expired = await seedShareLink(fixture.admin, owner.userId, workspaceId, "expired");
  });

  after(async () => {
    await fixture?.teardown();
  });

  describe("sign-in and redirects", () => {
    it("SEED-P1: a signed-in user is bounced from /login into the workspace", async () => {
      const res = await api().get("/login").set("cookie", owner.cookie).redirects(0);
      assert.ok(REDIRECT.includes(res.status), `expected a redirect, got ${res.status}`);
      assert.equal(new URL(String(res.headers.location), SITE_ORIGIN).pathname, "/workspace");
    });

    it("LOGIN-P1: a safe ?next= is honoured", async () => {
      const res = await api().get("/login?next=/billing").set("cookie", owner.cookie).redirects(0);
      assert.equal(new URL(String(res.headers.location), SITE_ORIGIN).pathname, "/billing");
    });

    it("LOGIN-N1: an off-site ?next= falls back to the workspace", async () => {
      for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
        const res = await api().get(`/login?next=${next}`).set("cookie", owner.cookie).redirects(0);
        const to = new URL(String(res.headers.location), SITE_ORIGIN);
        assert.notEqual(to.hostname, "evil.example", `next=${next}`);
        assert.equal(to.pathname, "/workspace", `next=${next}`);
      }
    });

    it("MSUB-P1: an org with no Stripe customer is sent to /billing, never to Stripe", async () => {
      const res = await api().get("/manage-subscription").set("cookie", owner.cookie).redirects(0);
      const to = assertSameOriginRedirect(res, SITE_ORIGIN, "no customer");
      assert.equal(to.pathname, "/billing");
    });
  });

  describe("git OAuth state, signed in", () => {
    const callback = (cookie: string, query: string) =>
      api().get(`/api/git/github/callback?${query}`).set("cookie", cookie).redirects(0);

    it("GIT-S1: a callback with no state cookie is refused", async () => {
      const res = await callback(owner.cookie, "code=x&state=github.abc");
      const to = assertSameOriginRedirect(res, SITE_ORIGIN, "no cookie");
      assert.equal(to.searchParams.get("git_error"), "state");
    });

    it("GIT-S2: a state that does not match the cookie is refused", async () => {
      const res = await callback(`${owner.cookie}; tg_git_state=github.expected`, "code=x&state=github.forged");
      assert.equal(new URL(String(res.headers.location)).searchParams.get("git_error"), "state");
    });

    it("GIT-S3: a matching state minted for ANOTHER provider is refused", async () => {
      const res = await callback(`${owner.cookie}; tg_git_state=gitlab.same`, "code=x&state=gitlab.same");
      assert.equal(new URL(String(res.headers.location)).searchParams.get("git_error"), "state");
    });

    it("GIT-S4: the state cookie is single-use — every callback clears it", async () => {
      const res = await callback(`${owner.cookie}; tg_git_state=github.expected`, "code=x&state=github.forged");
      const raw = res.headers["set-cookie"] as unknown;
      const cookies: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      const cleared = cookies.find((c) => c.startsWith("tg_git_state="));
      assert.ok(cleared, "the callback did not touch the state cookie");
      assert.match(cleared, /^tg_git_state=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });
  });

  describe("POST /api/workspace/translate", () => {
    const translate = (cookie: string) => api().post("/api/workspace/translate").set("cookie", cookie);

    it("TR-P1: answers a deterministic compose result, never the managed engine", async () => {
      const res = await translate(owner.cookie).send({ prompt: "a web app on app service with a postgres database" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      for (const key of ["model", "reply", "added", "engine"]) assert.ok(key in res.body, `missing ${key}`);
      assert.notEqual(res.body.engine, "managed", "the test server spent on a managed model");
      assert.ok(Array.isArray(res.body.model.nodes) && res.body.model.nodes.length > 0, "no nodes composed");
    });

    it("TR-N1: malformed and out-of-bounds bodies are 400", async () => {
      assertApiError(await translate(owner.cookie).set("content-type", "application/json").send("{not json"), 400, "Invalid JSON body");
      assertApiError(await translate(owner.cookie).send({ prompt: "" }), 400, /^Invalid prompt:/);
      assertApiError(await translate(owner.cookie).send({ prompt: "x".repeat(4001) }), 400, /^Invalid prompt:/);
      assertApiError(await translate(owner.cookie).send({ prompt: "x", model: { nodes: "no" } }), 400, /^Invalid model/);
    });

    it("TR-N2: a body over the 2 MB cap is 413", async () => {
      assertApiError(await translate(owner.cookie).send({ prompt: "x".repeat(2_100_000) }), 413, "Request body too large");
    });

    it("TR-RL1: the 21st call in a minute from one user is 429 — and only for that user", async () => {
      let last: Awaited<ReturnType<ReturnType<typeof translate>["send"]>> | undefined;
      for (let i = 0; i < 21; i++) last = await translate(flood.cookie).send({ prompt: "a storage account" });
      assert.ok(last);
      assertRateLimited(last);
      assert.equal((await translate(other.cookie).send({ prompt: "a storage account" })).status, 200);
    });
  });

  describe("POST /api/workspace/read-diagram", () => {
    const read = (cookie: string) =>
      api().post("/api/workspace/read-diagram").set("cookie", cookie).send({ mediaType: "image/png", data: "iVBORw0KGgo=" });

    it("RD-N1: with managed inference off it is a clear 409, never a silent sample", async () => {
      assertApiError(await read(owner.cookie), 409, /managed inference/);
    });

    it("RD-RL1: the 6th call in a minute from one user is 429", async () => {
      let last: Awaited<ReturnType<typeof read>> | undefined;
      for (let i = 0; i < 6; i++) last = await read(flood.cookie);
      assert.ok(last);
      assertRateLimited(last);
    });
  });

  describe("cross-user isolation in the app layer", () => {
    it("ISO-P1: the owner's canvas loads their workspace (positive control)", async () => {
      const res = await api().get(`/workspace/canvas?id=${workspaceId}`).set("cookie", owner.cookie);
      assert.equal(res.status, 200);
      assert.ok(res.text.includes(NAME), "owner cannot load their own workspace");
    });

    it("ISO-N1: another user asking for that id gets an empty canvas, not the workspace", async () => {
      const res = await api().get(`/workspace/canvas?id=${workspaceId}`).set("cookie", other.cookie);
      assert.ok([200, 404].includes(res.status), `status ${res.status}`);
      assert.ok(!res.text.includes(NAME), "LEAK: another user's workspace rendered");
    });

    it("ISO-N2: the workspace list shows only the caller's own workspaces", async () => {
      const mine = await api().get("/workspace").set("cookie", owner.cookie);
      const theirs = await api().get("/workspace").set("cookie", other.cookie);
      assert.ok(mine.text.includes(NAME), "owner's list misses their workspace (positive control)");
      assert.ok(!theirs.text.includes(NAME), "LEAK: another user's workspace is listed");
    });
  });

  describe("share links, opened anonymously", () => {
    it("SHARE-P1: a live link renders the workspace read-only and keeps it out of search", async () => {
      const res = await api().get(`/shared/${links.live}`);
      assert.equal(res.status, 200);
      assert.ok(res.text.includes(NAME), "the shared page does not show the workspace");
      assert.ok(res.text.includes("Read-only review link"));
      assert.match(res.text, /<meta name="robots" content="noindex, ?nofollow"/);
    });

    it("SHARE-N1: revoked, expired and unknown links are the same 404", async () => {
      for (const token of [links.revoked, links.expired, randomBytes(24).toString("base64url")]) {
        const res = await api().get(`/shared/${token}`);
        assert.equal(res.status, 404);
        assert.ok(!res.text.includes(NAME), "a dead link leaked the workspace");
      }
    });
  });
});
