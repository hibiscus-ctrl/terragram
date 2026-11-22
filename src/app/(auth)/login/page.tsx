import { redirect } from "next/navigation";

import { githubOauthEnabled, googleOauthEnabled } from "@/config/flags";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { getOrCreateOrg } from "@/features/account/controllers/get-or-create-org";
import {
  signInWithOAuth,
  signInWithPassword,
  signInWithSso,
  signUpWithPassword,
} from "@/app/(auth)/auth-actions";
import { AuthUI } from "@/app/(auth)/auth-ui";
import { safeNextPath } from "@/utils/safe-next";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ exists?: string; next?: string }>;
}) {
  const user = await getAuthenticatedUser();
  const { exists, next } = await searchParams;
  // Only a path on this site is honoured, so a crafted link can't open-redirect after auth.
  const explicitNext = safeNextPath(next);

  if (user) {
    // `getOrCreateOrg` provisions (idempotent) before bouncing an already-signed-in
    // user back into the app, so a provisioning anomaly self-heals here instead of
    // looping through the guards.
    await getOrCreateOrg();
    redirect(explicitNext ?? "/workspace");
  }

  const googleEnabled = googleOauthEnabled();
  const githubEnabled = githubOauthEnabled();
  // Name only the providers this deployment actually offers — listing GitHub when
  // the provider is off sends the reader to a button that is not there.
  const methods = ["password", githubEnabled ? "GitHub" : null, googleEnabled ? "Google" : null]
    .filter(Boolean)
    .join(" and ");
  const notice =
    exists === "1"
      ? `You already have an account with this email. Sign in below — your ${methods} sign-ins all share one account.`
      : undefined;

  // The (auth) layout provides the shared header/footer and centers the card.
  return (
    <AuthUI
      mode="login"
      signInWithOAuth={signInWithOAuth}
      signInWithPassword={signInWithPassword}
      signUpWithPassword={signUpWithPassword}
      signInWithSso={signInWithSso}
      googleEnabled={googleEnabled}
      githubEnabled={githubEnabled}
      notice={notice}
      next={explicitNext ?? undefined}
    />
  );
}
