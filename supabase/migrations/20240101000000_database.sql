-- ============================================================================
-- TERRAGRAM CLOUD — schema for the objects Terragram owns.
--
-- Every table, index and policy created here is prefixed `terragram_`. That is
-- not decoration: during development Terragram and Infraweaver Cloud share ONE
-- Supabase project, so the prefix is what keeps two products' tables apart in a
-- single `public` schema, and what makes it obvious at a glance which rows a
-- change can reach.
--
-- PREREQUISITE — the Infraweaver Cloud base schema.
-- Terragram reuses that schema's identity, tenancy and billing tables rather
-- than forking them: `users`, `orgs`, `memberships`, `org_invites`,
-- `usage_events`, `audit_log`, and the `is_org_member` / `set_membership` /
-- `record_managed_usage` / `usage_totals_since` functions. This file does NOT
-- create or modify any of them. It used to carry a copy, and that copy had
-- drifted several months behind — applying it would have silently replaced the
-- live `handle_new_user` trigger and ~30 policies with older bodies. A shared
-- database has exactly one owner per object, and for those objects it is not
-- Terragram.
--
-- IDEMPOTENT — safe to re-run against a live database with data. Apply with:
--   npm run db:apply                   -- converge, keeps data (the normal path)
--   npm run db:exec -- "<alter ...>"    -- a one-off ad-hoc statement
--
-- MAINTENANCE RULE: a new column on an existing table must be added in BOTH its
-- create-table block (so a fresh build has it) AND the CONVERGE DELTAS section
-- at the foot (so `db:apply` reaches a live DB — `create table if not exists`
-- never alters an existing table).
--
-- Tenancy: workspaces are personal-account scoped (`user_id`). The service-role
-- data layer scopes by user in code (features/workspace/store.ts); the policies
-- below are defence in depth, not the only gate.
-- ============================================================================

-- ============================================================================
-- Workspaces — a Terragram diagram/Terraform workspace and its model history.
-- ============================================================================
create table if not exists terragram_workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  name text not null,
  mode text not null default 'chat-diagram',
  cloud text not null default 'azure',
  -- Terraform or OpenTofu; the generator emits the matching provider block.
  tool text not null default 'terraform',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
alter table terragram_workspaces enable row level security;
create index if not exists terragram_workspaces_user_updated_idx
  on terragram_workspaces (user_id, updated_at desc);
drop policy if exists "Owner can read terragram workspaces." on terragram_workspaces;
create policy "Owner can read terragram workspaces." on terragram_workspaces for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Owner can write terragram workspaces." on terragram_workspaces;
create policy "Owner can write terragram workspaces." on terragram_workspaces for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Point-in-time model snapshots; the most recent row is the workspace's current
-- model. `transcript` carries the conversation that produced the snapshot, so
-- reloading a workspace restores what was said, not just what was built.
create table if not exists terragram_workspace_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references terragram_workspaces on delete cascade not null,
  model jsonb not null,
  transcript jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
alter table terragram_workspace_snapshots enable row level security;
create index if not exists terragram_workspace_snapshots_ws_created_idx
  on terragram_workspace_snapshots (workspace_id, created_at desc);
drop policy if exists "Owner can read terragram snapshots." on terragram_workspace_snapshots;
create policy "Owner can read terragram snapshots." on terragram_workspace_snapshots for select to authenticated
  using (exists (select 1 from terragram_workspaces w
                 where w.id = workspace_id and w.user_id = (select auth.uid())));
drop policy if exists "Owner can write terragram snapshots." on terragram_workspace_snapshots;
create policy "Owner can write terragram snapshots." on terragram_workspace_snapshots for all to authenticated
  using (exists (select 1 from terragram_workspaces w
                 where w.id = workspace_id and w.user_id = (select auth.uid())))
  with check (exists (select 1 from terragram_workspaces w
                      where w.id = workspace_id and w.user_id = (select auth.uid())));

-- ============================================================================
-- Evidence receipts — the audit trail the review gate produces.
-- A receipt that only lived in the approver's browser tab was not an audit trail.
-- The bundle is re-derivable from `model` + `plan`, so the row carries both along
-- with the hash and signature that pin them.
-- ============================================================================
create table if not exists terragram_evidence_bundles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references terragram_workspaces on delete cascade,
  user_id uuid references auth.users on delete cascade not null,
  content_hash text not null,
  signature text,
  key_id text,
  engine text not null,
  cloud text not null,
  tool text not null default 'terraform',
  approver text not null,
  approved_at timestamptz not null,
  explanation text,
  model jsonb not null,
  plan jsonb not null,
  created_at timestamptz not null default timezone('utc', now())
);
alter table terragram_evidence_bundles enable row level security;
create index if not exists terragram_evidence_bundles_user_created_idx
  on terragram_evidence_bundles (user_id, created_at desc);
create index if not exists terragram_evidence_bundles_ws_created_idx
  on terragram_evidence_bundles (workspace_id, created_at desc);
drop policy if exists "Owner can read terragram evidence." on terragram_evidence_bundles;
create policy "Owner can read terragram evidence." on terragram_evidence_bundles for select to authenticated
  using ((select auth.uid()) = user_id);
-- Owning the row is not enough to write it: the workspace it names must be the
-- caller's too, or a user could file evidence against someone else's workspace.
-- A receipt with no workspace is the caller's alone.
drop policy if exists "Owner can write terragram evidence." on terragram_evidence_bundles;
create policy "Owner can write terragram evidence." on terragram_evidence_bundles for all to authenticated
  using ((select auth.uid()) = user_id
         and (workspace_id is null
              or exists (select 1 from terragram_workspaces w
                         where w.id = workspace_id and w.user_id = (select auth.uid()))))
  with check ((select auth.uid()) = user_id
              and (workspace_id is null
                   or exists (select 1 from terragram_workspaces w
                              where w.id = workspace_id and w.user_id = (select auth.uid()))));

-- ============================================================================
-- Share links — read-only reviewer access to one workspace.
-- The review gate implies a second person. A link grants sight of the diagram,
-- plan and receipts; approval stays with the owner, so the link can never act.
-- Only the token's sha256 is stored: a leaked database row cannot open a link.
-- ============================================================================
create table if not exists terragram_share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references terragram_workspaces on delete cascade not null,
  created_by uuid references auth.users on delete cascade not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);
alter table terragram_share_links enable row level security;
create index if not exists terragram_share_links_ws_idx
  on terragram_share_links (workspace_id, created_at desc);
-- The link's creator must own the workspace it opens. Checking `created_by`
-- alone let a user plant a link (their own token, any expiry) on someone else's
-- workspace, which the real owner could then neither see nor revoke.
drop policy if exists "Owner can manage terragram share links." on terragram_share_links;
create policy "Owner can manage terragram share links." on terragram_share_links for all to authenticated
  using ((select auth.uid()) = created_by
         and exists (select 1 from terragram_workspaces w
                     where w.id = workspace_id and w.user_id = (select auth.uid())))
  with check ((select auth.uid()) = created_by
              and exists (select 1 from terragram_workspaces w
                          where w.id = workspace_id and w.user_id = (select auth.uid())));

-- ============================================================================
-- Per-user workspace preferences.
-- A table of its own rather than a column on the shared `users` row: `users`
-- belongs to the Infraweaver base schema, and a product that adds columns to
-- another product's table cannot be moved to its own database later without a
-- migration in both.
-- ============================================================================
create table if not exists terragram_user_settings (
  user_id uuid primary key references auth.users on delete cascade,
  -- Shape is validated by `workspaceSettingsSchema` before it lands.
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);
alter table terragram_user_settings enable row level security;
drop policy if exists "Owner can read terragram settings." on terragram_user_settings;
create policy "Owner can read terragram settings." on terragram_user_settings for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Owner can write terragram settings." on terragram_user_settings;
create policy "Owner can write terragram settings." on terragram_user_settings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ============================================================================
-- Git connections — one per user per host, for opening pull requests as them.
-- Tokens are sealed (AES-256-GCM, key in the deployment env) before they reach
-- this table; a leaked row is ciphertext. Only the service role reads it, so
-- the policies below permit nothing to the authenticated role on purpose.
-- ============================================================================
create table if not exists terragram_git_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  provider text not null check (provider in ('github', 'gitlab')),
  account_login text not null,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider)
);
alter table terragram_git_connections enable row level security;
create index if not exists terragram_git_connections_user_idx
  on terragram_git_connections (user_id);

-- ----------------------------------------------------------------------------
-- Grants. The anon/authenticated roles reach these tables only through RLS; the
-- service role bypasses it and is what the data layer uses.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on
  terragram_workspaces,
  terragram_workspace_snapshots,
  terragram_evidence_bundles,
  terragram_share_links,
  terragram_user_settings
  to authenticated, service_role;
grant select, insert, update, delete on terragram_git_connections to service_role;

-- ============================================================================
-- CONVERGE DELTAS — columns added after a table's create block above.
-- (none yet)
-- ============================================================================
