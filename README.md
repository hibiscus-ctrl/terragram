# Terragram (`terragram-ui`)

**Terragram** translates between plain English, architecture diagrams, and Terraform through one
auditable internal model — with a review gate before any code lands. One Next.js codebase, one deploy:
the marketing site, the diagram workspace, and the account/billing backend.

> Licensed under [AGPL-3.0-only](./LICENSE).

## What this is

- **The workspace** (`/workspace`) — a three-pane translator (compose/parse · React Flow canvas ·
  code/evidence) with four modes: Chat → Diagram, Chat → Terraform, Diagram → Terraform,
  Terraform → Diagram. Words, diagram, and code never drift because all three flow through one
  internal model (`src/features/workspace/model.ts`).
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
| `npm run db:migrate` / `db:types` / `db:link` | Apply the consolidated schema / regen types / link |
| `npm run stripe:setup` | Idempotent Stripe products/prices/meters |

## Project structure

```text
src/app/(marketing)       marketing site + docs + legal
src/app/(auth)            sign-in / sign-up (GitHub OAuth + email)
src/app/(account)         account + subscription management
src/app/(app)             the workspace (/workspace) + personal /billing and /settings
src/app/api               workspace translate, Stripe webhooks, proxy usage callback
src/features/workspace    the model boundary: model, modes, engine, terraform, evidence, store
src/features/billing      Stripe metering, plan flip, managed-model proxy mint
src/features/account      auth/org controllers, action guards
src/libs                  Supabase / Stripe clients, rate limiter
supabase/migrations       the consolidated schema (single database.sql)
```

## Verification & CI

The gates (all run in CI — `.github/workflows/ci.yml`): `tsc --noEmit`, Biome, `next build`,
`npm test`, and the self-test. Biome handles linting only (its formatter is off; there is no
formatter step — match the surrounding style by hand).

## Security

See [`SECURITY.md`](./SECURITY.md) for responsible disclosure.
