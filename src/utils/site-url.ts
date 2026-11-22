/**
 * Canonical public origin for the deployment — the single source of truth for
 * `metadataBase`, `robots.txt`, `sitemap.xml`, and any absolute URL we emit.
 *
 * Set `NEXT_PUBLIC_SITE_URL` to the production origin in the Railway/deploy env.
 * Railway (and similar hosts) expose the public domain WITHOUT a scheme
 * (`terragram-ui-production.up.railway.app`), but `new URL()` — used for
 * `metadataBase` — requires one, so we normalize: add `https://` when missing and
 * strip any trailing slash. Falls back to localhost for local dev.
 */
function normalizeOrigin(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "http://localhost:3000";
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

export const SITE_URL = normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL);

/** Absolute URL for a site-relative path, e.g. `siteUrl("/auth/callback")`. */
export function siteUrl(path = ""): string {
  const cleanPath = path.replace(/^\/+/, "");
  return cleanPath ? `${SITE_URL}/${cleanPath}` : SITE_URL;
}
