import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { withRedirectErrors } from "@/features/api/route-errors";
import { callbackUrl, GIT_STATE_COOKIE } from "@/features/git/oauth-state";
import { githubAccountLogin } from "@/features/git/github";
import { gitlabAccountLogin } from "@/features/git/gitlab";
import { exchangeCode, isGitProvider, providerConfig } from "@/features/git/providers";
import { saveConnection } from "@/features/git/store";
import { logger } from "@/libs/log";
import { constantTimeEqual } from "@/utils/crypto";
import { siteUrl } from "@/utils/site-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("api/git-callback");

/**
 * OAuth return leg. The host redirects here with `code` and `state`; the state
 * must match the cookie set when the flow started, and must name this provider.
 * Every failure lands back on the settings page with a reason rather than a bare
 * error page, because the person is mid-task.
 */
async function handleGet(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const settings = (query: string) => NextResponse.redirect(siteUrl(`/workspace/settings?${query}`));

  if (!isGitProvider(provider)) return settings("git_error=unknown-provider");
  const config = providerConfig(provider);
  if (!config) return settings("git_error=not-configured");

  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.redirect(siteUrl("/login"));

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const expected = jar.get(GIT_STATE_COOKIE)?.value;
  jar.delete(GIT_STATE_COOKIE);

  if (!code || !state || !expected || !constantTimeEqual(state, expected) || !state.startsWith(`${provider}.`)) {
    return settings("git_error=state");
  }

  try {
    const token = await exchangeCode(config, code, callbackUrl(provider));
    const login =
      provider === "github"
        ? await githubAccountLogin(token.accessToken, config.apiUrl)
        : await gitlabAccountLogin(token.accessToken, config.apiUrl);
    const saved = await saveConnection(user.id, provider, login, token);
    return settings(saved ? `connected=${provider}` : "git_error=store");
  } catch (err) {
    // Redacted: the OAuth exchange's failure carries the provider's response,
    // which on some hosts includes the access token it just issued.
    log.error("callback failed", { provider, err });
    return settings("git_error=exchange");
  }
}

export const GET = withRedirectErrors(siteUrl("/workspace/settings?git_error=exchange"))(handleGet);
