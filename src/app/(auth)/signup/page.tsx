import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { githubOauthEnabled, googleOauthEnabled } from "@/config/flags";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { getOrCreateOrg } from "@/features/account/controllers/get-or-create-org";
import { signInWithOAuth, signInWithPassword, signUpWithPassword } from "@/app/(auth)/auth-actions";
import { AuthUI } from "@/app/(auth)/auth-ui";
import { safeNextPath } from "@/utils/safe-next";

// Own title — without it the page inherits the (auth) layout's "Sign in".
export const metadata: Metadata = {
  title: "Create your account",
};

export default async function SignUp({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getAuthenticatedUser();
  // Only a path on this site is honoured (e.g. the invite link that sent them here),
  // so a crafted link can't open-redirect after sign-up.
  const explicitNext = safeNextPath((await searchParams).next);

  if (user) {
    await getOrCreateOrg();
    redirect(explicitNext ?? "/workspace");
  }

  // The (auth) layout provides the shared header/footer and centers the card.
  return (
    <AuthUI
      mode="signup"
      signInWithOAuth={signInWithOAuth}
      signInWithPassword={signInWithPassword}
      signUpWithPassword={signUpWithPassword}
      googleEnabled={googleOauthEnabled()}
      githubEnabled={githubOauthEnabled()}
      next={explicitNext ?? undefined}
    />
  );
}
