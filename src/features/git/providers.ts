// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two Git hosts Terragram can open a change on, and the OAuth shape of each.
 *
 * Both use a per-user authorization: the token acts as the signed-in person, the
 * pull request is theirs, and nothing here holds a long-lived server credential to
 * anyone's repositories. A provider whose client id and secret are not in the
 * environment is simply "not configured" — the UI says so rather than offering a
 * connection that would fail at the redirect.
 *
 * Registration (ops): a GitHub App with Contents read/write, Pull requests
 * read/write and Metadata read, "Request user authorization (OAuth) during
 * installation" enabled, and this deployment's callback URL. GitLab: an application
 * with the `api` scope. Set the four env vars and both connect buttons come alive.
 */

export const GIT_PROVIDERS = ["github", "gitlab"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export function isGitProvider(value: unknown): value is GitProvider {
  return typeof value === "string" && (GIT_PROVIDERS as readonly string[]).includes(value);
}

export const PROVIDER_LABEL: Record<GitProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

/** What a provider calls the thing this feature opens. */
export const CHANGE_NOUN: Record<GitProvider, string> = {
  github: "pull request",
  gitlab: "merge request",
};

export type ProviderConfig = {
  provider: GitProvider;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** REST base, no trailing slash. */
  apiUrl: string;
  /** Scopes requested at authorization; empty when the app's permissions decide. */
  scope: string;
};

function gitlabBase(): string {
  return (process.env.GITLAB_URL?.trim() || "https://gitlab.com").replace(/\/+$/, "");
}

/** The provider's configuration from the environment, or null when unset. */
export function providerConfig(provider: GitProvider): ProviderConfig | null {
  if (provider === "github") {
    const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
    const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    return {
      provider,
      clientId,
      clientSecret,
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      apiUrl: "https://api.github.com",
      // A GitHub App's permissions govern the token; scopes are an OAuth-App concept.
      scope: "",
    };
  }
  const clientId = process.env.GITLAB_APP_ID?.trim();
  const clientSecret = process.env.GITLAB_APP_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const base = gitlabBase();
  return {
    provider,
    clientId,
    clientSecret,
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    apiUrl: `${base}/api/v4`,
    scope: "api",
  };
}

export function isProviderConfigured(provider: GitProvider): boolean {
  return providerConfig(provider) !== null;
}

/** Where to send the browser to authorize. `state` is checked on return. */
export function authorizeUrl(config: ProviderConfig, state: string, redirectUri: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (config.scope) url.searchParams.set("scope", config.scope);
  return url.toString();
}

export type IssuedToken = {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token stops working, or null when it does not expire. */
  expiresAt: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function requestToken(
  config: ProviderConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<IssuedToken> {
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(
      `${PROVIDER_LABEL[config.provider]} did not issue a token: ${data.error_description ?? data.error ?? response.status}`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:
      typeof data.expires_in === "number" ? new Date(nowMs + data.expires_in * 1000).toISOString() : null,
  };
}

/** Trade the authorization code for the user's token. */
export function exchangeCode(
  config: ProviderConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<IssuedToken> {
  return requestToken(
    config,
    { code, redirect_uri: redirectUri, grant_type: "authorization_code" },
    fetchImpl,
    nowMs,
  );
}

/** Renew an expiring token. GitHub Apps with expiring tokens and GitLab both rotate
 *  the refresh token on use, so the caller must store what comes back. */
export function refreshAccessToken(
  config: ProviderConfig,
  refreshToken: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<IssuedToken> {
  return requestToken(
    config,
    { refresh_token: refreshToken, redirect_uri: redirectUri, grant_type: "refresh_token" },
    fetchImpl,
    nowMs,
  );
}
