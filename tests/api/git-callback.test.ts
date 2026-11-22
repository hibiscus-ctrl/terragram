/**
 * The Git host OAuth return leg: GET /api/git/{provider}/callback.
 *
 * Its failure contract is "redirect back to the workspace settings with a
 * reason, never an error page", and every redirect must land on OUR origin
 * whatever the request carries. .env.test configures GitHub with placeholder
 * client credentials (never dialled: every case here stops before the code
 * exchange) and blanks GitLab, so both branches are reachable.
 *
 * The state checks need a signed-in user and live in seeded.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { api, CONFIGURED, SITE_ORIGIN } from "./helpers/client.ts";
import { assertSameOriginRedirect } from "./helpers/shape.ts";

const GITHUB = CONFIGURED && Boolean(process.env.GITHUB_APP_CLIENT_ID);

describe("GET /api/git/{provider}/callback", { skip: !GITHUB }, () => {
  it("GIT-N1: an unknown provider lands on settings with a reason", async () => {
    const res = await api().get("/api/git/bitbucket/callback?code=x&state=bitbucket.x").redirects(0);
    const to = assertSameOriginRedirect(res, SITE_ORIGIN, "unknown provider");
    assert.equal(to.pathname, "/workspace/settings");
    assert.equal(to.searchParams.get("git_error"), "unknown-provider");
  });

  it("GIT-N2: an unconfigured provider says so instead of starting an exchange", async () => {
    const res = await api().get("/api/git/gitlab/callback?code=x&state=gitlab.x").redirects(0);
    const to = assertSameOriginRedirect(res, SITE_ORIGIN, "gitlab unconfigured");
    assert.equal(to.searchParams.get("git_error"), "not-configured");
  });

  it("GIT-N3: a signed-out caller is sent to /login, never to the exchange", async () => {
    const res = await api().get("/api/git/github/callback?code=x&state=github.x").redirects(0);
    const to = assertSameOriginRedirect(res, SITE_ORIGIN, "signed out");
    assert.equal(to.pathname, "/login");
  });

  it("GIT-N4: no request input can move the redirect off-site", async () => {
    // The route builds every Location from SITE_URL; none of these may leak into it.
    const hostile = [
      "/api/git/github/callback?next=https://evil.example&redirect_uri=https://evil.example",
      "/api/git/github/callback?state=github.x&code=x&return_to=//evil.example",
      "/api/git/gitlab/callback?redirect=https:%2F%2Fevil.example",
    ];
    for (const path of hostile) {
      const res = await api()
        .get(path)
        .set("x-forwarded-host", "evil.example")
        .set("x-forwarded-proto", "https")
        .redirects(0);
      assertSameOriginRedirect(res, SITE_ORIGIN, path);
    }
  });

  it("GIT-N5: POST is 405", async () => {
    assert.equal((await api().post("/api/git/github/callback").send({})).status, 405);
  });
});
