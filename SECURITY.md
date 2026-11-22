# Security Policy

Terragram translates between plain English, architecture diagrams, and Terraform through one auditable
internal model. Its security model is **deterministic by default**: the workspace runs without any model
credentials, and managed UK inference is an opt-in, server-side seam (the browser never holds a model key).
We take vulnerabilities in that boundary seriously.

## Reporting a vulnerability

**Please report privately — do not open a public issue or PR for a suspected vulnerability.**

Email **security@terragram.dev** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if possible),
- affected component / endpoint / version or commit.

We aim to acknowledge within **2 business days** and to agree a remediation timeline after triage. Please give us
a reasonable window to fix and release before any public disclosure (coordinated disclosure).

## Safe harbour

If you make a good-faith effort to follow this policy while researching a vulnerability, we will not pursue or
support legal action against you, and we will work with you to understand and resolve the issue quickly. Good
faith means: only test against your own account and organisation, do not access, modify or retain data that
is not yours, do not degrade the service for other tenants, give us reasonable time to fix before public
disclosure, and stop as soon as you have enough to write the report. If you are unsure whether something is in
bounds, ask first at <security@terragram.dev> — asking is always in bounds.

This is not a bug-bounty programme; we pay no monetary rewards. We do credit researchers unless you would rather
we didn't.

## Scope

In scope for this repository (`terragram-ui`):

- The API routes (`src/app/api/**`) — session auth on the workspace translate endpoint, the Stripe
  webhook signature check, and the double-authenticated managed-inference usage callback.
- The workspace persistence layer (owner-only RLS on `workspaces`/`workspace_snapshots`, `user_id`
  scoping in the data layer).
- The account/billing server actions and data access (tenancy, RBAC, rate limiting).
- Managed-model proxy credential handling (the short-lived `tmpx_` HMAC token mint and the
  usage-callback secret).

## Handling of secrets (design notes)

- The browser never holds a model credential: managed inference mints a short-lived, org-scoped,
  HMAC-signed `tmpx_` token **server-side** and calls the EU Bedrock proxy from the server.
- Any stored API credentials are kept only as **SHA-256 hashes** and shown to the user exactly once;
  secret-bearing tables are **service-role only** (no member-readable RLS policy).
- Tenancy is enforced app-side from the authenticated session's org/user id on every route and server
  action; the dashboard path additionally uses Supabase RLS.
- Shared-secret comparisons (proxy callback, token hashes) are constant-time.

Please report any deviation from the above.
