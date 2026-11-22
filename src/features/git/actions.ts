// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { actionRateLimit } from "@/features/account/controllers/action-guards";
import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";
import { siteUrl } from "@/utils/site-url";

import { callbackUrl } from "./oauth-state.ts";

import type { EngineKind } from "@/features/workspace/engine";
import { type Cloud, type InfraModel, infraModelSchema } from "@/features/workspace/model";
import { buildEvidenceReceipt } from "@/features/workspace/sign";
import type { TerraformTool } from "@/features/workspace/terraform";
import { githubOpenPullRequest, githubRepositories, type OpenedChange } from "./github.ts";
import { gitlabOpenMergeRequest, gitlabProjects } from "./gitlab.ts";
import { branchName, changeBody, changeFiles, changeTitle, commitMessage, normaliseDirectory } from "./pr.ts";
import {
  authorizeUrl,
  CHANGE_NOUN,
  GIT_PROVIDERS,
  type GitProvider,
  isGitProvider,
  isProviderConfigured,
  PROVIDER_LABEL,
  providerConfig,
  refreshAccessToken,
} from "./providers.ts";
import { GIT_STATE_COOKIE } from "./oauth-state.ts";
import { deleteConnection, getConnection, listConnections, type OpenConnection, saveConnection } from "./store.ts";

/**
 * Server actions for the Git integration. The acting user always comes from the
 * session; the token used for a host call comes from that user's own connection and
 * is never returned to the browser.
 */

export type ProviderStatus = {
  provider: GitProvider;
  label: string;
  /** The env vars for this host are set, so a connection can be made. */
  configured: boolean;
  accountLogin: string | null;
};

export async function gitProviderStatusAction(): Promise<ProviderStatus[]> {
  const user = await getAuthenticatedUser();
  const connections = user ? await listConnections(user.id) : [];
  return GIT_PROVIDERS.map((provider) => ({
    provider,
    label: PROVIDER_LABEL[provider],
    configured: isProviderConfigured(provider),
    accountLogin: connections.find((c) => c.provider === provider)?.accountLogin ?? null,
  }));
}

/** Begin the authorization: returns the URL the browser should navigate to. */
export async function startGitConnectAction(
  providerRaw: string,
): Promise<{ url: string } | { error: string }> {
  const user = await getAuthenticatedUser();
  if (!user) return { error: "Sign in first." };
  if (!isGitProvider(providerRaw)) return { error: "Unknown provider." };
  const config = providerConfig(providerRaw);
  if (!config) return { error: `${PROVIDER_LABEL[providerRaw]} is not configured on this deployment.` };

  // The state binds the callback to this browser AND this provider, so a code for
  // one host cannot be replayed against the other.
  const state = `${providerRaw}.${randomBytes(24).toString("base64url")}`;
  const jar = await cookies();
  jar.set(GIT_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return { url: authorizeUrl(config, state, callbackUrl(providerRaw)) };
}

export async function disconnectGitAction(providerRaw: string): Promise<{ ok: boolean }> {
  const user = await getAuthenticatedUser();
  if (!user || !isGitProvider(providerRaw)) return { ok: false };
  return { ok: await deleteConnection(user.id, providerRaw) };
}

/**
 * The user's connection with a live access token, refreshing an expired one and
 * storing the rotated pair. Null when not connected or when the host is unconfigured.
 */
async function liveConnection(userId: string, provider: GitProvider): Promise<OpenConnection | null> {
  const config = providerConfig(provider);
  const connection = await getConnection(userId, provider);
  if (!config || !connection) return null;
  const expiring = connection.expiresAt && new Date(connection.expiresAt).getTime() < Date.now() + 60_000;
  if (!expiring) return connection;
  if (!connection.refreshToken) return null;
  const renewed = await refreshAccessToken(config, connection.refreshToken, callbackUrl(provider));
  await saveConnection(userId, provider, connection.accountLogin, renewed);
  return { ...connection, ...renewed };
}

export type RepositoryChoice = { id: string; label: string; hint?: string };

/** Repositories or projects the user can push to on a host. */
export async function listGitRepositoriesAction(
  providerRaw: string,
): Promise<{ repositories: RepositoryChoice[] } | { error: string }> {
  const user = await getAuthenticatedUser();
  if (!user) return { error: "Sign in first." };
  if (!isGitProvider(providerRaw)) return { error: "Unknown provider." };
  const config = providerConfig(providerRaw);
  const connection = await liveConnection(user.id, providerRaw);
  if (!config || !connection) return { error: `Connect ${PROVIDER_LABEL[providerRaw]} in workspace settings first.` };

  try {
    if (providerRaw === "github") {
      const repos = await githubRepositories(connection.accessToken, config.apiUrl);
      return {
        repositories: repos.map((r) => ({
          id: r.fullName,
          label: r.fullName,
          ...(r.private ? { hint: "private" } : {}),
        })),
      };
    }
    const projects = await gitlabProjects(connection.accessToken, config.apiUrl);
    return { repositories: projects.map((p) => ({ id: String(p.id), label: p.pathWithNamespace })) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not list repositories." };
  }
}

/**
 * Open a change on the host with the approved plan and its receipt. The plan and
 * receipt are rebuilt here from the model, exactly as the review gate did — the
 * browser sends what was approved, never the files, so what lands in the pull
 * request is what this server would build.
 */
export async function openChangeAction(args: {
  provider: string;
  repository: string;
  directory: string;
  model: InfraModel;
  cloud: Cloud;
  engine: EngineKind;
  tool?: TerraformTool;
}): Promise<{ change: OpenedChange; noun: string } | { error: string }> {
  const user = await getAuthenticatedUser();
  if (!user) return { error: "Sign in first." };
  if (!isGitProvider(args.provider)) return { error: "Unknown provider." };
  const provider = args.provider;

  const limited = await actionRateLimit("git-open-change", user.id, {
    limit: 10,
    windowMs: 60 * 60_000,
    message: "That is a lot of pull requests for one hour.",
  });
  if (!limited.ok) return { error: limited.error };

  const parsed = infraModelSchema.safeParse(args.model);
  if (!parsed.success) return { error: "The model could not be read." };
  if (!args.repository.trim()) return { error: "Choose a repository." };

  const config = providerConfig(provider);
  const connection = await liveConnection(user.id, provider);
  if (!config || !connection) return { error: `Connect ${PROVIDER_LABEL[provider]} in workspace settings first.` };

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const approver = (typeof meta.full_name === "string" && meta.full_name) || user.email || user.id;
  const cloud: Cloud = args.cloud === "aws" ? "aws" : "azure";
  const engine: EngineKind = args.engine === "managed" ? "managed" : "deterministic";
  const tool: TerraformTool = args.tool === "opentofu" ? "opentofu" : "terraform";

  const { receipt, terraform } = await buildEvidenceReceipt(
    parsed.data,
    cloud,
    engine,
    approver,
    new Date().toISOString(),
    { tool },
  );

  const files = changeFiles(terraform.files, receipt, normaliseDirectory(args.directory) || "terraform");
  const common = {
    token: connection.accessToken,
    apiUrl: config.apiUrl,
    branch: branchName(receipt),
    files,
    commitMessage: commitMessage(receipt),
    title: changeTitle(parsed.data, receipt),
    body: changeBody({ model: parsed.data, receipt, files, verifyUrl: siteUrl("/verify") }),
  };

  try {
    const change =
      provider === "github"
        ? await githubOpenPullRequest({ ...common, repository: args.repository })
        : await gitlabOpenMergeRequest({ ...common, projectId: Number(args.repository) });
    return { change, noun: CHANGE_NOUN[provider] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Could not open the ${CHANGE_NOUN[provider]}.` };
  }
}
