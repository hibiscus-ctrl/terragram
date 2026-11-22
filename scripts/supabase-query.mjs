/**
 * Shared helper for the db:* scripts that run SQL against the LIVE Supabase
 * project via the Management API (the same engine as the dashboard SQL editor) —
 * no Docker, no local `pg`, no migration-tracking state. Targets the project in
 * this repo's .env.local (NEXT_PUBLIC_SUPABASE_URL) and authenticates with a
 * Supabase PERSONAL ACCESS TOKEN (SUPABASE_ACCESS_TOKEN — not anon/service keys).
 */

export function projectRef() {
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").match(
    /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in)/i,
  )?.[1];
  if (!ref) {
    console.error(
      "Could not resolve the project ref. Set NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co) in .env.local.",
    );
    process.exit(1);
  }
  return ref;
}

export function accessToken() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "SUPABASE_ACCESS_TOKEN is required (a Supabase PERSONAL ACCESS TOKEN — not the\n" +
        "anon/publishable/service key). Create one at Supabase → Account → Access Tokens,\n" +
        "add it to .env.local as SUPABASE_ACCESS_TOKEN=..., then re-run.",
    );
    process.exit(1);
  }
  return token;
}

/** Run a SQL string against the live project; resolves to the response body
 *  (JSON rows for SELECTs, '[]' otherwise). Throws on a non-2xx response. */
export async function runSql(query, { ref = projectRef(), token = accessToken() } = {}) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Query failed (${res.status}) against project ${ref}:\n${body}`);
  return body;
}

/** The email to re-seed as org owner: an explicit arg, else SEED_OWNER_EMAIL,
 *  else the first entry of SUPER_OWNER_EMAILS. Empty string when none is set. */
export function ownerEmail(explicit) {
  return (
    explicit ||
    process.env.SEED_OWNER_EMAIL ||
    (process.env.SUPER_OWNER_EMAILS || "").split(",")[0] ||
    ""
  ).trim();
}

/** The GitHub App installation id to re-link onto the org: an explicit arg, else
 *  SEED_INSTALL_ID. Null when unset or not a positive integer. Re-linking the App
 *  is what lets Option A (tokenless OIDC) mint run tokens — without it, reporting
 *  401s ("No active GitHub App installation"). */
export function installId(explicit) {
  const raw = (explicit ?? process.env.SEED_INSTALL_ID ?? "").toString().trim();
  return /^\d+$/.test(raw) ? raw : null;
}

/**
 * Idempotent SQL that makes `email`'s account an ADMIN of an org (creating a
 * personal org if they have none), and backfills their public.users profile.
 * Mirrors getOrCreateOrg's provisioning, and promotes an existing membership to
 * `admin` (there is no org Owner role). When `install` (a GitHub App
 * installation id) is given, it re-links the org so Option A OIDC reporting works
 * again after a wipe. Safe to re-run.
 */
export function ownerSeedSql(email, install = null) {
  const safe = email.replace(/'/g, "''");
  // install is pre-validated to digits by installId(); guard again defensively.
  const linkApp =
    install && /^\d+$/.test(String(install))
      ? `  update public.orgs set github_installation_id = ${install}
        where id = v_org
          and not exists (select 1 from public.orgs x where x.github_installation_id = ${install} and x.id <> v_org);
  raise notice 'linked org % to GitHub App installation ${install}', v_login;`
      : "";
  return `do $seed$
declare v_uid uuid; v_org uuid; v_login text; v_name text;
begin
  select u.id,
         coalesce(u.raw_user_meta_data->>'user_name', u.raw_user_meta_data->>'preferred_username', split_part(u.email, '@', 1)),
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1))
    into v_uid, v_login, v_name
    from auth.users u
    where lower(u.email) = lower('${safe}')
    limit 1;
  if v_uid is null then
    raise notice 'no auth.users row for % — sign in once, then re-run the owner seed', '${safe}';
    return;
  end if;
  insert into public.users (id, full_name, avatar_url)
    select v_uid, v_name, u.raw_user_meta_data->>'avatar_url' from auth.users u where u.id = v_uid
    on conflict (id) do nothing;
  select o.id into v_org
    from public.orgs o join public.memberships m on m.org_id = o.id
    where m.user_id = v_uid order by o.created_at limit 1;
  if v_org is null then
    insert into public.orgs (github_login, name) values (v_login, v_name)
      on conflict (github_login) do update set name = excluded.name
      returning id into v_org;
  end if;
  insert into public.memberships (org_id, user_id, role) values (v_org, v_uid, 'admin')
    on conflict (org_id, user_id) do update set role = 'admin';
${linkApp}
  raise notice '% is now an admin of org %', '${safe}', v_login;
end $seed$;`;
}
