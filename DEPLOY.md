# Deploying terragram-ui to Railway

The app ships as a **Dockerized Next.js standalone server** ([Dockerfile](./Dockerfile),
[railway.toml](./railway.toml)). Railway builds the image, injects env vars, and
gates each deploy on the `/api/health/ready` readiness probe (503 until the database
answers; it also reports half-configured features). `/api/health` is liveness only.

## 1. Create the service

```bash
# one-time, from this directory
railway login
railway init                 # or: railway link   (to an existing project)
railway up                   # builds the Dockerfile and deploys
railway domain               # generate a public URL
```

Railway auto-detects `railway.toml` and the `Dockerfile`. No build/start command needed.

## 2. Environment variables

Set these on the Railway **service** (Variables tab, or `railway variables --set k=v`).
`NEXT_PUBLIC_*` are also passed to the **build** automatically (they're inlined into the
client bundle), so they must be correct _before_ the build runs.

> **Full reference — what each variable is and where to generate it:**
> [`.env.local.example`](./.env.local.example) is the annotated source of truth. The
> quick list below is the summary.

### Required

| Variable                               | Notes                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | `https://<ref>.supabase.co`                                                                                |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`)                                             |
| `SUPABASE_SECRET_KEY`                  | `sb_secret_…` (or legacy `SUPABASE_SERVICE_ROLE_KEY`) — server-only                                        |
| `STRIPE_SECRET_KEY`                    | `sk_…` — server-only (checkout, webhook, catalogue)                                                        |
| `STRIPE_WEBHOOK_SECRET`                | `whsec_…` from the Stripe webhook pointing at `https://<domain>/api/webhooks`                              |
| `NEXT_PUBLIC_SITE_URL`                 | **the public Railway domain**, e.g. `https://app.terragram.dev` (used for OAuth redirects + absolute URLs) |

### Optional (feature-gated — unset features skip gracefully)

`NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED`,
`WORKSPACE_ENGINE`, `TERRAGRAM_WORKSPACE_MODEL`,
`TERRAGRAM_MODEL_PROXY_URL`, `TERRAGRAM_MODEL_PROXY_SECRET`, `TERRAGRAM_PROXY_CALLBACK_SECRET`,
`EVIDENCE_SIGNING_KEY`, `EVIDENCE_SIGNING_KEY_ID`,
`RATE_LIMIT_TRUSTED_PROXIES`, `JOBS_DRAIN_SECRET` (see [3.2](#32-schedule-the-usage-jobs)),
`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION`, `EMAIL_FROM` (invite email: both
keys, a send-only IAM key with `ses:SendEmail`, and a verified SES identity for the sender —
`Terragram <invites@terragram.dev>` in `eu-west-2` unless overridden; without them invites are
copy-the-link only).
See [.env.local.example](./.env.local.example) for the full annotated list.

> **Stripe prices are automatic.** `npm run stripe:setup` creates the catalogue and the
> app resolves price ids from stable lookup keys at runtime — no `STRIPE_*_PRICE_ID` or
> `STRIPE_COST_METER_EVENT_NAME` to set (they still work as optional overrides). The only
> Stripe vars are the three in **Required**.

> **Evidence signing.** Set `EVIDENCE_SIGNING_KEY` to a PKCS#8 PEM **Ed25519**
> private key (and `EVIDENCE_SIGNING_KEY_ID` to its id) to attach a detached
> signature over each evidence bundle's `content_hash`, so an auditor can verify the
> bundle wasn't altered after export. Unset ⇒ bundles ship unsigned (the
> `content_hash` still pins the content). Generate a keypair with
> `openssl genpkey -algorithm ed25519 -out key.pem`. For the **published release
> artifact** (not per-export bundles), prefer **Sigstore/cosign keyless signing** in
> the release workflow (`cosign sign-blob` with the OIDC identity) — that ties into
> the SLSA/provenance posture and needs no long-lived key.

> **Managed inference** is off unless `WORKSPACE_ENGINE=managed` _and_ the model
> proxy is configured (`TERRAGRAM_MODEL_PROXY_URL`/`_SECRET`). Until then the
> workspace runs the deterministic engine — no keys, no spend. Set a distinct
> `TERRAGRAM_PROXY_CALLBACK_SECRET` so the usage callback doesn't reuse the
> token-signing secret.

`PORT` and `HOSTNAME` are handled for you (Railway sets `PORT`; the server binds `0.0.0.0`).

## 3. Post-deploy

- Set the Supabase Auth redirect URLs (Auth → URL Configuration) to the Railway domain.
- Point the Stripe webhook at the deployed `/api/webhooks`, then copy the signing
  secret into `STRIPE_WEBHOOK_SECRET`.
- **Apply the schema** — `npm run db:apply` (needs a Supabase **Personal Access Token** in
  `.env.local` as `SUPABASE_ACCESS_TOKEN`, plus `NEXT_PUBLIC_SUPABASE_URL`). The consolidated
  `supabase/migrations/20240101000000_database.sql` is the source of truth and is now **idempotent**:
  `db:apply` converges the live schema to it (creates anything missing, applies post-squash columns
  via the "CONVERGE DELTAS" block) and is safe to re-run, **keeping all data**. Use
  `npm run db:reset -- --yes` only to fully rebuild a throwaway/test DB. The DEV SEED block populates
  demo data for the first org after you sign in once.

## 3.1 Make yourself the org owner

The app auto-provisions a fresh sign-in as `admin`. To hold the privileged `owner` role
(needed for delete/transfer): **sign in once** to the deployed app, then run
`npm run db:seed-owner -- you@example.com` (or set `SEED_OWNER_EMAIL`). Idempotent — safe to re-run.

## 3.2 Schedule the usage jobs

Two scheduler-facing routes, both poked by Supabase `pg_cron` + `pg_net` and
authenticated by `JOBS_DRAIN_SECRET` sent as `x-jobs-secret`:

- **`POST /api/jobs/flush-usage`, every 15 minutes** (`terragram-flush-usage`).
  Managed-model usage reaches the Stripe meter through it. Without a schedule it is
  reported only at the subscription renewal (or when someone opens the billing page),
  so it lands a cycle in arrears. The flush is idempotent, so an overlapping or
  repeated tick never double-bills.
- **`POST /api/jobs/reconcile-managed`, every 6 hours** (`terragram-reconcile-managed`).
  Every `tmpx_` mint writes a `managed_mint` row to `usage_events`. This compares
  mints against the gateway's usage reports per org over the last 24 hours and logs a
  warning (`proxy tokens minted with zero usage reports`) for any org with mints and
  no reports: the gateway spent on Bedrock but never told the Cloud, so the spend was
  never billed. Read-only: it flags, it never corrects the ledger. A flagged org is
  the signal to check the gateway's own logs.

**Prerequisite: `infraweaver-ui`'s product-discriminator migration must be applied
first** (`npm run db:apply` in `infraweaver-ui`). It adds `usage_events.product` and
the `p_product` parameter on the shared usage functions. Without it, this app cannot
record managed usage or reconcile its mints, its flush finds nothing, and
Infraweaver's own 15-minute flush reports every org's metered rows, terragram's
included, on Infraweaver's meter. Do not deploy this app, and do not schedule the
jobs below, until that migration is applied. To check, this query must return a row:
`select 1 from information_schema.columns where table_name = 'usage_events' and column_name = 'product';`

1. Set `JOBS_DRAIN_SECRET` on the Railway service (`openssl rand -hex 24`; at least 16
   characters, or the routes refuse it). Until it is set the routes answer 401 to
   everyone, the cron included; `/api/health/ready` reports `jobsDrain` as `off`.
2. Schedule both jobs, once per deployment and again whenever the secret or the domain
   changes (it is idempotent: it upserts the Vault secret and replaces each job):

   ```bash
   SITE_URL=https://<your-domain> JOBS_DRAIN_SECRET=<the Railway value> npm run cron:schedule
   ```

   It needs `SUPABASE_ACCESS_TOKEN` in `.env.local`, like the `db:*` scripts.

This is **not** in the migration: the cron jobs live in the shared `cron` schema and
embed this deployment's URL, and the migration creates only `terragram_*` objects.
The script runs the equivalent of this, which can also be pasted into the Supabase SQL
editor. The secret goes to Vault rather than into the jobs, because `cron.job` stores the
command verbatim, readable by anyone with SQL access. The names are prefixed because
the project is shared with Infraweaver, which runs its own jobs on the same extensions.

```sql
-- pg_cron and pg_net are already enabled in the shared project (Infraweaver's jobs use them).

-- 1. store the secret once (to rotate: select vault.update_secret(<id>, '<new value>');)
-- select vault.create_secret('<JOBS_DRAIN_SECRET>', 'terragram_jobs_drain_secret');

-- 2. flush managed usage to the Stripe meter every 15 minutes
-- select cron.schedule('terragram-flush-usage', '*/15 * * * *', $cron$
--   select net.http_post(
--     url     := '<NEXT_PUBLIC_SITE_URL>/api/jobs/flush-usage',
--     headers := jsonb_build_object(
--       'content-type', 'application/json',
--       'x-jobs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'terragram_jobs_drain_secret')
--     ),
--     timeout_milliseconds := 20000
--   );
-- $cron$);

-- 3. flag orgs whose gateway spent but never reported, every 6 hours (read-only)
-- select cron.schedule('terragram-reconcile-managed', '25 */6 * * *', $cron$
--   select net.http_post(
--     url     := '<NEXT_PUBLIC_SITE_URL>/api/jobs/reconcile-managed',
--     headers := jsonb_build_object(
--       'content-type', 'application/json',
--       'x-jobs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'terragram_jobs_drain_secret')
--     ),
--     timeout_milliseconds := 20000
--   );
-- $cron$);

-- check:  select * from cron.job_run_details
--           where jobid = (select jobid from cron.job where jobname = 'terragram-flush-usage')
--           order by start_time desc limit 5;
-- (and the same with jobname = 'terragram-reconcile-managed')
-- remove: select cron.unschedule('terragram-flush-usage');
--         select cron.unschedule('terragram-reconcile-managed');
```

## 4. Local parity

```bash
docker build -t terragram-ui \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=… \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=… \
  --build-arg NEXT_PUBLIC_SITE_URL=http://localhost:3000 .
docker run -p 3000:3000 --env-file .env.local terragram-ui
```
