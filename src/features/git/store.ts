// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";

import { encryptionKeyFromEnv, openToken, sealToken } from "./crypto.ts";
import type { GitProvider } from "./providers.ts";
import type { IssuedToken } from "./providers.ts";

/**
 * Per-user Git connections, one row per provider. Tokens are sealed before they
 * reach the database and opened only here, so no other module ever sees a stored
 * token in the clear. Like the workspace store, every function is scoped by the
 * acting user and degrades to "not connected" when the table is not provisioned.
 */

export type ConnectionSummary = {
  provider: GitProvider;
  accountLogin: string;
  connectedAt: string;
};

export type OpenConnection = ConnectionSummary & IssuedToken;

export async function listConnections(userId: string): Promise<ConnectionSummary[]> {
  const { data } = await supabaseAdminClient
    .from("terragram_git_connections")
    .select("provider, account_login, created_at")
    .eq("user_id", userId);
  return (data ?? []).map((row) => ({
    provider: row.provider as GitProvider,
    accountLogin: row.account_login,
    connectedAt: row.created_at,
  }));
}

/** Upsert the user's connection for a provider, sealing the tokens first. */
export async function saveConnection(
  userId: string,
  provider: GitProvider,
  accountLogin: string,
  token: IssuedToken,
): Promise<boolean> {
  const key = encryptionKeyFromEnv();
  if (!key) throw new Error("GIT_TOKEN_ENCRYPTION_KEY is not set; refusing to store a Git token in the clear");

  const { error } = await supabaseAdminClient.from("terragram_git_connections").upsert(
    {
      user_id: userId,
      provider,
      account_login: accountLogin,
      access_token: sealToken(token.accessToken, key),
      refresh_token: token.refreshToken ? sealToken(token.refreshToken, key) : null,
      expires_at: token.expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
  return !error;
}

/** The connection with its tokens opened, or null when absent or unopenable. */
export async function getConnection(userId: string, provider: GitProvider): Promise<OpenConnection | null> {
  const key = encryptionKeyFromEnv();
  if (!key) return null;
  const { data } = await supabaseAdminClient
    .from("terragram_git_connections")
    .select("account_login, access_token, refresh_token, expires_at, created_at")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data) return null;
  try {
    return {
      provider,
      accountLogin: data.account_login,
      connectedAt: data.created_at,
      accessToken: openToken(data.access_token, key),
      refreshToken: data.refresh_token ? openToken(data.refresh_token, key) : null,
      expiresAt: data.expires_at,
    };
  } catch {
    // A row sealed under a different key is unusable; treat it as not connected
    // rather than surfacing ciphertext errors to the user.
    return null;
  }
}

export async function deleteConnection(userId: string, provider: GitProvider): Promise<boolean> {
  const { error } = await supabaseAdminClient
    .from("terragram_git_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  return !error;
}
