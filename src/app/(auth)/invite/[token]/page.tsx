// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";

import { InviteAcceptClient } from "@/components/app/invite-accept-client";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { previewInvite } from "@/features/app/invites";

export const metadata: Metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

/**
 * The invite link. Public on purpose (the proxy does not guard `/invite`): the
 * token is the credential, and a signed-out visitor must be able to see what they
 * were invited to before signing in. Accepting needs a session.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getAuthenticatedUser();
  const preview = await previewInvite(token, user?.id);
  return <InviteAcceptClient token={token} preview={preview} signedIn={Boolean(user)} />;
}
