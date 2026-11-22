# terragram-ui — Terragram Cloud

Next.js 16 App Router + React 19, Supabase, Stripe, Tailwind 4, Biome, tests via `node --test`.
Deployed on Railway. Terragram turns a diagram or brief into reviewed Terraform: the model
proposes component *kinds*, and the HCL comes from the deterministic registry in
`src/features/workspace/kinds.ts`. Node **24** is the floor (`engines`, `.nvmrc`, Dockerfile, CI
all agree). npm, not pnpm: use `npm ci`, and a lockfile mismatch is a real failure to fix in the
commit.

## Gates

```bash
npm run typecheck:all && npm test && npm run check:design && npm run check:imports && npm run knip && npm run lint
```

CI runs the same set, plus:

- `test:coverage`: the unit suite under c8 `--all` with floors.
- `test:components`: React components under happy-dom.
- The **Generated Terraform** job: `validate:emit` runs `fmt`, `validate`, tflint, trivy and
  checkov over every brief and template, and `check:modules` checks every pinned module call
  against its published interface.
- `lint:lockfile`.
- The diff-scoped security gates in `security-scan.yml`: Semgrep, Trivy secrets and the
  dep-CVE base-vs-head check.

**Coverage only measures logic the unit suite owns.** That is `src/features/{workspace,billing,git}`
and a few utilities, minus the store/action/Stripe adapters. c8 `--all` makes a module there that
no test imports count as 0% instead of vanishing from the total. Pages, components and server
actions are covered by the API suite and Cypress. When a server action needs a unit test, put its
decisions in a `*-core.ts` behind injected collaborators and bind the adapters in the action
file. Worked examples:

- `features/app/invite-accept-core.ts`
- `features/app/org-core.ts`
- `features/billing/proxy-usage-core.ts`

**Touching `src/app/api/**`, `src/features/api/**` or the migration?** Also run
`npm run test:api:all`. It is not in the gate line because it boots dev servers and seeds
throwaway `apitest-terragram-*` users in the live project. Stop any running `next dev` first,
since Next allows only one per project. It runs two suites in sequence, never together:

- **`test:api`** (port 3100, `.env.test`) is the HTTP contract suite.
- **`test:api:unconfigured`** (port 3101, `.env.test.unconfigured`) boots the app with the Stripe
  webhook, model-proxy and jobs secrets **blanked**, to prove those routes fail closed.
  - Blank the keys, never delete them. env-cmd layers over `.env.local`, so an omitted key comes
    back with its real value.
  - `GUARD-1` fails the run if the server is not actually underconfigured.

**Cypress (`npm run e2e`) needs a `next dev` on :3000** against `.env.local`. Its seeders
(`scripts/e2e-seed-*.mjs`, through `cy.task`) are idempotent and write to the live project.

- A spec that creates rows must delete them; one that cannot stays read-only.
- Assert on structure, hashes and round-tripped data, never on model wording.
- From an editor-hosted terminal the Cypress binary refuses to start with
  `bad option: --smoke-test`. That is `ELECTRON_RUN_AS_NODE=1` in the environment, so run
  `env -u ELECTRON_RUN_AS_NODE npm run e2e`.

`npm run test:rls` impersonates two users inside a rolled-back transaction. It proves user A can
neither read nor write user B's `terragram_*` rows, including planting a share link on B's
workspace. Run it after any policy change.

## Database: one project, two products

The Supabase project is **shared with Infraweaver Cloud** and treated as production. Terragram
owns only what is prefixed `terragram_`.

- `users`, `orgs`, `memberships`, `org_invites`, `audit_log`, `usage_events`, `rate_limit_buckets`
  and their functions (`set_membership`, `record_managed_usage`, `consume_rate_limit`, …) belong to
  `infraweaver-ui`'s migration. Never create, alter or re-declare them here.
  - When that schema moves (the org Owner role was retired, `audit_log` gained `actor_id`), sync
    the shared blocks of `src/libs/supabase/types.ts` from `infraweaver-ui` and follow the
    behaviour change.
  - `usage_events` rows carry a `product`, because each app flushes its own rows to its own Stripe
    meter. Every read here filters `.eq("product", USAGE_PRODUCT)`, and every call to
    `record_managed_usage`, `usage_totals_since`, `orgs_with_unreported_usage` or
    `managed_mint_reconciliation` passes `p_product: USAGE_PRODUCT` (`'terragram'`, from
    `features/billing/managed-meter.ts`). Those functions default to `'infraweaver'`, so a missing
    `p_product` silently books terragram usage as Infraweaver's. `tests/usage-product-scope.test.ts`
    enforces both rules. The column and the parameter come from `infraweaver-ui`'s migration, so
    that migration must be applied (`npm run db:apply` there) before this app deploys. Until then,
    every `p_product` call fails.
- Rate-limit keys are sent prefixed `terragram:`. Infraweaver uses the same key names, so without
  the prefix the two apps would drain each other's buckets.
- **Always `npm run db:apply`, never `db:migrate`.** `db:apply` runs apply → `db:drift` → types.
  `create table if not exists` silently skips a new column on an existing table, so add it in the
  create block **and** in CONVERGE DELTAS, and let the drift gate prove it landed.
- The file runs as **one transaction**. A failing statement rolls back everything after it, so
  re-run after a fix and confirm `db:drift` reports no drift.
- Migrations, `db:reset`, destructive SQL and data exports need the owner's explicit go-ahead.
- RLS is defence in depth (the data layer uses the service role and scopes by `user_id` in code),
  but it must still be right. Every write policy on a workspace-linked table checks that the
  caller owns the **workspace**, not just the row's own user column. `tests/rls-isolation.test.ts`
  enforces this statically.

## Two auth paths, deliberately different: don't collapse them

- **Render path.** `getAuthenticatedUser` uses `auth.getClaims()`, which verifies the token locally
  against the JWKS. It returns the narrow `AuthenticatedUser` (`id`, `email`, `user_metadata`).
  - The org it acts on is the **active org** (`getCurrentMembership` → `resolveAmbientOrgId` in
    `get-or-create-org.ts`): the `tg_active_org` cookie's org when the user is still a member of it,
    else their oldest membership (`active-org-core.ts`). The cookie is a preference, never a grant.
  - `resolveAmbientOrgId` is React `cache()`d per request and reads the cookie INSIDE the cached
    function. Keep it there: the cache is keyed on the user id alone, so a cookie read outside it
    would not be part of what the cached answer was computed from.
  - Only a server action or route handler can set the cookie (`setActiveOrgCookie`): the org menu's
    `switchActiveOrg` and invite acceptance. Routes stay org-less; there is no `/o/[slug]`.
- **Sign-in path.** Provisioning (`provision-on-sign-in.ts`, the auth callback) keeps
  `auth.getUser()` and the full `User`. It needs `email_confirmed_at` and `identities`, which are
  not JWT claims.
  - Never widen `AuthenticatedUser` with those fields. It would compile, then read `undefined` at
    runtime.
  - `acceptPendingInvites` takes a mandatory `User` for exactly that reason.
- **Proxy.** It keeps `getUser()` so a signed-out or suspended session stops on its next request.

## Roles: read [docs/permissions.md](docs/permissions.md)

- The org roles are **Admin / Maintainer / Auditor / Billing Manager**. There is no org Owner:
  "transfer" hands the org to another Admin and leaves it.
- Authorisation goes through the capability matrix (`can` / `allows` in `features/account/controllers/permissions.ts`, `guardPage` for pages), never a role
  comparison.
- Privileged actions write their typed audit event first and abort if the write fails.
- Change a rule → update that doc in the same change; `tests/permissions-doc.test.ts` keeps them
  in step.

## Logging and secrets

- Server code logs through `logger(scope)` from `src/libs/log.ts`. It writes one JSON line,
  redacted by `@infraweaver-io/core`, and knows the `tmpx_` token shape. Never `console.*` an
  error object on the server, because provider errors embed the request that carried the
  credential. Client error boundaries keep `console.error`.
- Compare secrets, signatures and OAuth state with `constantTimeEqual` (`src/utils/crypto.ts`),
  never `===` or a raw `timingSafeEqual`.
- Every API route is wrapped in `withRouteErrors` / `withRedirectErrors`, and declares an auth
  posture that `tests/route-auth-posture.test.ts` checks. A new unauthenticated route goes into
  that test's `PUBLIC_ROUTES` with a reason.
- Scheduler routes (`/api/jobs/*`, poked by Supabase `pg_cron` + `pg_net`) gate on
  `requireJobsSecret` (`JOBS_DRAIN_SECRET` as `x-jobs-secret`). Unset or wrong, the answer is the
  same 401: configuration presence is published only by `/api/health/ready`. The cron jobs live in
  the shared `cron` schema, so they are scheduled by `npm run cron:schedule` (DEPLOY.md), never by
  the migration. The API suites never send the correct secret: past it, the flush calls Stripe.
- `/api/health` is liveness. `/api/health/ready` (database + env report) is what Railway's deploy
  gate and `e2e:ci` poll.

## Biome

- **The formatter is OFF** (lint rules only), and the checkout is CRLF. Never run
  `biome check --write`, `lint:fix` or any formatter over the tree. Format only the files you
  changed.
- **Never put `//` comments in `biome.json`.** Biome silently discards the whole config and falls
  back to defaults. The tell is a file count in the thousands instead of a few hundred. Keep
  `$schema` on the installed version.
- The pre-commit hook (`lefthook.yml`) lints staged files only.

## Hand-synced with other repos: change one, change both

Nothing catches these except the fixtures named here.

- `src/features/billing/proxy.ts` `mintProxyToken` / `verifyProxyToken` and `/api/proxy-usage` <=>
  `infraweaver-proxy` `src/token.ts` / `src/usage.ts` / `src/spendCap.ts`.
  - The token bytes, `iat`, the `x-infraweaver-proxy-secret` header, the cache-token fields and
    `overCap` are the gateway's contract.
  - Pinned by `contracts/proxy-token.json`. The contract tests byte-compare the sibling checkout
    at `../infraweaver-proxy` when it is present.
- `src/features/workspace/managed-models.ts` `MANAGED_MODEL_IDS` <=> the gateway's `bedrock_model_map`, pinned by
  `contracts/model-map.json`.
- The shared schema <=> `infraweaver-ui/supabase/migrations/` (see Database).

## `@infraweaver-io/*` are real dependencies

- `core`, `sandbox` and `attest` resolve from GitHub Packages via the `.npmrc` scope line. Auth is
  never committed: `~/.npmrc` locally, `GH_PACKAGES_TOKEN` in CI and in the Docker build.
- This repo is not in the `infraweaver-io` org, so the job's `GITHUB_TOKEN` cannot read the
  packages.
- A change in `infraweaver-packages` does nothing here until it is published and the version
  bumped.

## Working rules

- Planning and assessment notes (`TERRAGRAM-*.md`) are local only: never commit, push or link
  them, and don't cite them in code comments.
- Commits are plain Conventional Commits, with no AI attribution. `pull.rebase=true`, no merge
  commits on `main`.
- Simplest thing that works, surgical diffs, and a test that reproduces a bug before the fix.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
