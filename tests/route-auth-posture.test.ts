// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every route handler must declare an authentication posture.
 *
 * WHAT THIS PROVES: that the gate is *declared* on every route handler. The
 * failure mode it exists to catch is the one `rls-isolation.test.ts` catches for
 * tables: someone adds a route and the gate is simply never written.
 *
 * WHAT THIS DOES NOT PROVE: that the gates work at runtime. Route handlers cannot
 * be imported under `node --test` (`next/server` has no export condition plain
 * Node resolves), so source-level assertions are what is available here; the
 * HTTP half is `tests/api/` (`npm run test:api`).
 *
 * Adding a route makes this suite FAIL until you classify it. That is the point:
 * exposing something unauthenticated should be typed out on purpose, in a list a
 * reviewer reads, rather than arrived at by omission.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { filesUnder } from "./helpers/source-files.ts";

const appDir = fileURLToPath(new URL("../src/app/", import.meta.url));

/** Every recognised way a route can establish who is calling. */
const MECHANISMS: Record<string, RegExp> = {
  /** Signed-in browser session. */
  session: /getAuthenticatedUser\(|getCurrentMembership\(/,
  /** Stripe webhook HMAC — a CALL, never a mention. */
  webhookSignature: /constructStripeEvent\(|constructEventAsync\(|constructEvent\(/,
  /** A shared secret compared in constant time (the model proxy's callback). */
  sharedSecret: /constantTimeEqual\(|timingSafeEqual\(/,
  /** The scheduler credential (`JOBS_DRAIN_SECRET` as `x-jobs-secret`), through
   *  `requireJobsSecret` — the one place the job routes' constant-time compare lives. */
  jobsSecret: /requireJobsSecret\(/,
  /** A `tmpx_` token re-verified for its org (directly, or by the usage core it is injected into). */
  proxyToken: /verifyProxyToken\(|makeProxyUsage\(\{\s*verifyProxyToken,/,
};

/**
 * Routes served without authentication, each for a stated reason. Anything not
 * here must authenticate. Keep this list SHORT and argue for every entry.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "api/health":
    "Liveness probe for the platform healthcheck. Dependency-free and returns no user data.",
  "api/health/ready":
    "Readiness probe the deploy gate polls with no credentials. It reports ready or not with a dependency and env summary that holds no secret values and no user data.",
  "api/csp-report":
    "CSP violation collector. A browser posts violations with no credentials and cannot be given any. It answers 204 to everyone, writes nothing outside the process log, and is bounded by a body cap, a per-IP rate limit, a per-request violation cap and a capped key table.",
  "(auth)/auth/callback":
    "The OAuth / PKCE return leg. The caller is by definition not signed in yet: the one-time `code` IS the credential, and `exchangeCodeForSession` verifies it.",
  "(auth)/auth/confirm":
    "The emailed confirmation / magic-link / recovery link. The `token_hash` is the credential and `verifyOtp` verifies it.",
};

type Route = { id: string; source: string; body: string; mechanisms: string[] };

/** The route body with `import` statements removed, so an import alone can never
 *  satisfy a gate. */
function routeBody(source: string): string {
  return source
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s[^;]*?from\s+["'][^"']+["'];?\s*$/gm, "");
}

/** `source` with comments removed, so a comment cannot pass for code. The `[^:]`
 *  keeps a URL's `://` from being read as a comment start. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ROUTES: Route[] = filesUnder(appDir, /^route\.ts$/).map((file) => {
  const source = readFileSync(file, "utf8");
  const id = relative(appDir, file).replaceAll("\\", "/").replace(/\/route\.ts$/, "");
  const body = stripComments(routeBody(source));
  return {
    id,
    source,
    body,
    mechanisms: Object.entries(MECHANISMS)
      .filter(([, re]) => re.test(body))
      .map(([k]) => k),
  };
});

const route = (id: string): Route => {
  const found = ROUTES.find((r) => r.id === id);
  assert.ok(found, `expected route /${id} to exist`);
  return found;
};

describe("route auth posture", () => {
  it("found the route tree (guards against a silently empty suite)", () => {
    assert.ok(ROUTES.length >= 10, `expected the full route tree, found ${ROUTES.length}`);
  });

  for (const r of ROUTES) {
    it(`/${r.id} authenticates, or is a declared public route`, () => {
      if (r.id in PUBLIC_ROUTES) {
        assert.equal(
          r.mechanisms.length,
          0,
          `/${r.id} is listed as public but now authenticates — remove it from PUBLIC_ROUTES`,
        );
        return;
      }
      assert.ok(
        r.mechanisms.length > 0,
        `/${r.id} has no recognised authentication. Add a gate, or — if it is genuinely public — add it to PUBLIC_ROUTES with a reason.`,
      );
    });
  }

  for (const r of ROUTES.filter((x) => !(x.id in PUBLIC_ROUTES))) {
    it(`/${r.id} opts out of static rendering`, () => {
      // A cached authenticated response is a cross-user leak: Next would serve
      // one user's answer to the next caller.
      assert.match(r.source, /export const dynamic = "force-dynamic"/);
    });
  }

  it("keeps the public-route list free of stale entries", () => {
    const ids = new Set(ROUTES.map((r) => r.id));
    for (const id of Object.keys(PUBLIC_ROUTES)) {
      assert.ok(ids.has(id), `PUBLIC_ROUTES lists /${id}, which no longer exists — remove it`);
    }
  });
});

describe("the gates that carry money or credentials", () => {
  it("/api/proxy-usage needs BOTH the proxy secret and a valid token", () => {
    // Double-authenticated on purpose: the secret proves the caller is the
    // gateway, the token names the org that is billed.
    const r = route("api/proxy-usage");
    assert.ok(r.mechanisms.includes("sharedSecret"), "proxy secret is no longer compared");
    assert.ok(r.mechanisms.includes("proxyToken"), "the tmpx_ token is no longer verified");
    assert.ok(
      r.body.indexOf("secretOk(") < r.body.indexOf("parseBody("),
      "the secret must be checked before the body is read",
    );
  });

  it("/api/jobs/flush-usage checks the jobs secret before it reports anything to Stripe", () => {
    // The flush is idempotent, so an anonymous caller could not double-bill —
    // but it could drive Stripe calls at will. Only the scheduler holds the secret.
    const r = route("api/jobs/flush-usage");
    assert.deepEqual(r.mechanisms, ["jobsSecret"]);
    const gate = r.body.indexOf("requireJobsSecret(");
    assert.ok(gate >= 0 && gate < r.body.indexOf("flushAllPendingUsage("));
    assert.match(r.body, /if \(refused\) return refused;/);
  });

  it("/api/jobs/reconcile-managed checks the jobs secret before it reads any org's ledger", () => {
    // Read-only, but its answer names the orgs whose gateway usage went silent.
    const r = route("api/jobs/reconcile-managed");
    assert.deepEqual(r.mechanisms, ["jobsSecret"]);
    const gate = r.body.indexOf("requireJobsSecret(");
    assert.ok(gate >= 0 && gate < r.body.indexOf("reconcileManaged()"));
    assert.match(r.body, /if \(refused\) return refused;/);
  });

  it("the workspace model routes record every mint in the ledger, awaited by the runtime", () => {
    // A floating ledger promise can be dropped at a deploy or scale-down, losing the
    // very row the reconcile job compares against.
    for (const id of ["api/workspace/translate", "api/workspace/read-diagram"]) {
      assert.match(
        route(id).body,
        /recordMint: \(orgId, budgetPence\) => after\(recordManagedMint\(orgId, budgetPence\)\)/,
        `/${id} does not register its mint ledger write with after()`,
      );
    }
  });

  it("/api/webhooks verifies the Stripe signature before acting on the event", () => {
    const r = route("api/webhooks");
    const verify = r.body.indexOf("constructStripeEvent(");
    assert.ok(verify >= 0 && verify < r.body.indexOf("setOrgPlanFromSubscription("));
  });

  it("/api/webhooks and /api/csp-report rate-limit before reading the body", () => {
    for (const id of ["api/webhooks", "api/csp-report"]) {
      const r = route(id);
      const limit = r.body.indexOf("rateLimited(");
      assert.ok(limit >= 0, `/${id} is not rate-limited`);
      for (const read of ["readRawBody(", "request.text("]) {
        const at = r.body.indexOf(read);
        if (at >= 0) assert.ok(limit < at, `/${id} reads the body before the rate limit`);
      }
    }
  });

  it("the workspace model routes rate-limit per user, after auth and before the body", () => {
    for (const id of ["api/workspace/translate", "api/workspace/read-diagram"]) {
      const r = route(id);
      const auth = r.body.indexOf("getAuthenticatedUser(");
      const limit = r.body.indexOf("rateLimited(");
      assert.ok(auth >= 0 && limit > auth, `/${id} must authenticate, then rate-limit`);
      assert.match(r.body, /rateLimited\(`[\w-]+:\$\{user\.id\}`/, `/${id} is not keyed per user`);
      for (const read of ["parseBody(", "request.text("]) {
        const at = r.body.indexOf(read);
        if (at >= 0) assert.ok(limit < at, `/${id} reads the body before the rate limit`);
      }
    }
  });

  it("the git OAuth callback binds the state to the cookie AND to the provider", () => {
    // Without the cookie compare, a forged callback could attach an attacker's
    // repository account to the victim's session (login CSRF on the connection).
    const r = route("api/git/[provider]/callback");
    assert.match(r.body, /!constantTimeEqual\(state, expected\)/);
    assert.match(r.body, /state\.startsWith\(`\$\{provider\}\.`\)/);
    assert.match(r.body, /jar\.delete\(GIT_STATE_COOKIE\)/, "the state cookie must be single-use");
  });

  it("/auth/confirm and /auth/callback only honour a same-origin `next`, and spend the cookie", () => {
    // What counts as same-origin is `landingAfterSignIn`'s job (`safeNextPath` over
    // the link's `next` and the cookie), pinned in auth-next-core.test.ts.
    const confirm = route("(auth)/auth/confirm");
    assert.match(
      confirm.body,
      /const next = landingAfterSignIn\(jar\.get\(AUTH_NEXT_COOKIE\)\?\.value, searchParams\.get\("next"\)\);/,
    );
    const callback = route("(auth)/auth/callback");
    assert.match(callback.body, /const next = landingAfterSignIn\(jar\.get\(AUTH_NEXT_COOKIE\)\?\.value\);/);
    for (const r of [confirm, callback]) {
      assert.match(r.body, /jar\.delete\(\{ name: AUTH_NEXT_COOKIE, path: AUTH_NEXT_COOKIE_PATH \}\)/);
      assert.match(r.body, /NextResponse\.redirect\(`\$\{SITE_URL\}\$\{next\}`\)/);
    }
  });
});
