# Terragram (`terragram-ui`)

**Terragram** translates between plain English, architecture diagrams, and Terraform through one
auditable internal model — with a review gate before any code lands. One Next.js codebase, one deploy:
the marketing site, the diagram workspace, and the account/billing backend.

> Licensed under [AGPL-3.0-only](./LICENSE).

## What this is

- **The workspace** (`/workspace`) — a three-pane translator (compose/parse · React Flow canvas ·
  code/evidence) with four modes: Chat → Diagram, Chat → Terraform, Diagram → Terraform,
  Terraform → Diagram. Words, diagram, and code never drift because all three flow through one
  internal model (`packages/engine/src/model.ts`).
- **The engine** — deterministic by default (keyword compose + HCL parse + template emit, no LLM,
  no keys). Managed UK inference (AWS Bedrock via the EU proxy) is opt-in per deployment with
  `WORKSPACE_ENGINE=managed`; on any gateway error it falls back to the deterministic engine.
- **The marketing site** — landing, pricing, docs, FAQ, trust centre, legal; UK-residency framed.
- **Account + billing** — personal accounts (Supabase Auth), Stripe subscriptions + metered managed
  inference, `/billing` and `/settings`.

## Stack

- **Next.js 16** (App Router, RSC, route handlers, Turbopack) · **React 19**
- **@xyflow/react** (React Flow) + **dagre** — the diagram canvas + auto-layout
- **Supabase** — Postgres + Auth (GitHub OAuth + email) + RLS + Storage
- **Stripe** v22 (Basil API) — subscriptions + Billing Meter usage
- **Tailwind v4** (CSS-first) + shadcn-style primitives + **Sonner**
- **Zod 4** — the model contracts (`infraModelSchema`, translate request/response)
- Node **24+** (tests + self-test use native TypeScript stripping)

## Getting started

### Prerequisites

- Node.js **24+**, npm
- A Supabase project (UK/EU region for production residency)
- A Stripe account (billing only — the workspace runs without it)

### 1. Install & configure

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
```

`.env.local.example` documents every variable: Supabase (publishable/secret keys), Stripe, the
managed-model proxy (`TERRAGRAM_MODEL_PROXY_URL`/`_SECRET`, `TERRAGRAM_PROXY_CALLBACK_SECRET`,
`WORKSPACE_ENGINE`), and analytics.

### 2. Database

```bash
npm run db:link              # derives the project ref from NEXT_PUBLIC_SUPABASE_URL
npm run db:migrate           # applies supabase/migrations/* and regenerates types
```

Without the `workspaces`/`workspace_snapshots` tables applied, the workspace still runs — it degrades
to ephemeral (no create/load/save) by design.

### 3. Stripe (optional to start)

```bash
npm run stripe:setup         # creates products, prices and the Billing Meters (idempotent)
```

Add a webhook endpoint pointing at `/api/webhooks` and put its signing secret in
`STRIPE_WEBHOOK_SECRET`. Prices and meters are resolved by stable **lookup keys** at runtime.

### 4. Run

```bash
npm run dev      # http://localhost:3000
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` / `typecheck:all` | `tsc --noEmit` (src / src+tests) |
| `npm run lint` / `lint:fix` | Biome lint |
| `npm test` | Unit tests (node built-in runner, `tests/*.test.ts`) |
| `npm run test:cloud` | Pure-logic self-tests (proxy mint, token hashing, rate limiter, upload schema) |
| `npm run build:packages` | Bundle the CLI (`packages/cli/dist/terragram.mjs`) and build the engine library (`packages/engine/dist`) |
| `npm run schemas:gen` / `schemas:check` | Write / verify `schemas/*.schema.json`, generated from the engine's zod schemas |
| `npm run db:migrate` / `db:types` / `db:link` | Apply the consolidated schema / regen types / link |
| `npm run stripe:setup` | Idempotent Stripe products/prices/meters |

## Project structure

```text
src/app/(marketing)       marketing site + docs + legal
src/app/(auth)            sign-in / sign-up (GitHub OAuth + email)
src/app/(account)         account + subscription management
src/app/(app)             the workspace (/workspace) + personal /billing and /settings
src/app/api               workspace translate, Stripe webhooks, proxy usage callback
packages/engine           the generation engine (own package): model, kinds, terraform, hcl, receipts
packages/cli              the `terragram` command line, bundled into one file over the engine
schemas                   open JSON Schemas (Apache-2.0) for the model and the evidence receipt
src/features/workspace    the app's side of it: store, actions, managed inference, signing
src/features/billing      Stripe metering, plan flip, managed-model proxy mint
src/features/account      auth/org controllers, action guards
src/libs                  Supabase / Stripe clients, rate limiter
supabase/migrations       the consolidated schema (single database.sql)
```

## Command line and schemas

`packages/cli` is a `terragram` command over the same deterministic engine the workspace uses. It
runs offline with no model and no account, and builds into one file with no runtime dependencies
(Node 24 or later). Not published yet: build it with `npm run build:packages` and run
`node packages/cli/dist/terragram.mjs`.

```bash
terragram generate --prompt "A web app with a Postgres database" --cloud aws -o out/   # Terraform + model.json
terragram generate --mermaid diagram.mmd --tofu -o out/                               # from a Mermaid flowchart
terragram parse infra/ -o model.json                                                  # Terraform -> model
terragram render model.json -o diagram.svg
terragram explain model.json                                                          # plain-English description
terragram verify bundle/ --key signer.pem                                             # offline receipt check
```

`verify` reports "verified" only when the content hash recomputed from `model.json` and `plan/`
matches **and** the receipt's signature verifies against a public key you hold: `--key signer.pem`,
or `--trust keys.json` (a JSON object of key id to PEM, picked by the receipt's key id). The key must
come from outside the bundle; `signing-key.pem` inside it is never used, since whoever alters a
bundle can swap the key. The key the receipt carries must be the trusted one. An unsigned receipt
fails; `--allow-unsigned` checks the hashes only and prints `UNSIGNED`, which is not a pass.

Exit status is 0 on success, 1 when a command fails (including a receipt that does not verify)
and 2 for bad arguments; `--json` prints a machine-readable result where it helps.

The documents it reads and writes have JSON Schemas under [`schemas/`](schemas/):
`model.v1.schema.json` (`terragram.model/v1`) and `receipt.v2.schema.json`
(`terragram.receipt/v2`). They are Apache-2.0, so a tool can build against the formats without
taking on the AGPL, and they are generated, not hand-written.

## Verification & CI

The gates (all run in CI — `.github/workflows/ci.yml`): `tsc --noEmit`, Biome, `next build`,
`npm test`, the self-test, and a packages job (schemas current, CLI and engine builds, the CLI
matching the app's output). Biome handles linting only (its formatter is off; there is no
formatter step — match the surrounding style by hand).

## Security

See [`SECURITY.md`](./SECURITY.md) for responsible disclosure.
