import { siteUrl } from "@/utils/site-url";

import type { GitProvider } from "./providers.ts";

/** Cookie carrying the OAuth `state` between the redirect out and the callback. */
export const GIT_STATE_COOKIE = "tg_git_state";

/** The return leg's URL, as registered with the host. */
export function callbackUrl(provider: GitProvider): string {
  return siteUrl(`/api/git/${provider}/callback`);
}
