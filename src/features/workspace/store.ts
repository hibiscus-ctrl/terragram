// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes } from "node:crypto";

import { supabaseAdminClient } from "@/libs/supabase/supabase-admin";
import type { Database, Json } from "@/libs/supabase/types";

import { EMPTY_MODEL, type InfraModel, infraModelSchema } from "./model.ts";
import { isWorkspaceMode, type WorkspaceMode } from "./modes.ts";
import type { EvidenceReceipt } from "./receipt.ts";
import { parseSettings, type WorkspaceSettings } from "./settings.ts";
import { shareLinkOpens } from "./share-link.ts";
import type { TerraformFile, TerraformTool } from "./terraform.ts";

/**
 * Workspace persistence — the single place the workspace read/write path touches the
 * service-role client, so ownership scoping (`user_id`) is audited here rather than
 * repeated at every call site. RLS is the second line of defence.
 *
 * Every function degrades gracefully: a missing table or a transport error returns an
 * empty or neutral result so the workspace still runs ephemerally when persistence
 * is not provisioned. That is deliberate, not defensive clutter — a workspace that
 * refused to open because a migration had not been applied would be worse than one
 * that quietly forgets.
 */

type WorkspaceRow = Database["public"]["Tables"]["terragram_workspaces"]["Row"];

/** Snapshots kept per workspace. Old turns are pruned on write, so a long-running
 *  workspace cannot grow without bound. */
const SNAPSHOT_LIMIT = 50;

/** Share links expire; a link that never dies is not a review link, it is publication. */
const SHARE_LINK_TTL_DAYS = 14;

export type WorkspaceSummary = {
  id: string;
  name: string;
  mode: WorkspaceMode;
  cloud: "azure" | "aws";
  tool: TerraformTool;
  updatedAt: string;
};

/** One turn of the conversation, persisted alongside the snapshot it produced. */
export type TranscriptTurn = { role: "user" | "assistant"; text: string };

export type LoadedWorkspace = {
  summary: WorkspaceSummary;
  model: InfraModel;
  transcript: TranscriptTurn[];
};

export type SnapshotSummary = { id: string; createdAt: string; nodeCount: number };

function toSummary(row: WorkspaceRow): WorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    mode: isWorkspaceMode(row.mode) ? row.mode : "chat-diagram",
    cloud: row.cloud === "aws" ? "aws" : "azure",
    tool: row.tool === "opentofu" ? "opentofu" : "terraform",
    updatedAt: row.updated_at,
  };
}

function parseModel(value: Json | null | undefined): InfraModel {
  const parsed = infraModelSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_MODEL;
}

function parseTranscript(value: Json | null | undefined): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const role = (entry as { role?: unknown }).role;
    const text = (entry as { text?: unknown }).text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") return [];
    return [{ role, text: text.slice(0, 4000) }];
  });
}

/** Confirm the caller owns this workspace before any write touches it. */
async function ownsWorkspace(userId: string, id: string): Promise<boolean> {
  const { data } = await supabaseAdminClient
    .from("terragram_workspaces")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

/* -------------------------------------------------------------- workspaces -- */

/** The signed-in user's workspaces, most recently updated first. */
export async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const { data, error } = await supabaseAdminClient
    .from("terragram_workspaces")
    .select("id, name, mode, cloud, tool, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.map((row) => toSummary(row as WorkspaceRow));
}

/** Create a workspace. Returns its id, or null when persistence is unavailable. */
export async function createWorkspace(
  userId: string,
  input: { name: string; mode: WorkspaceMode; cloud: "azure" | "aws"; tool?: TerraformTool },
): Promise<string | null> {
  const { data, error } = await supabaseAdminClient
    .from("terragram_workspaces")
    .insert({
      user_id: userId,
      name: input.name,
      mode: input.mode,
      cloud: input.cloud,
      tool: input.tool ?? "terraform",
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id;
}

/** Load a workspace and its latest snapshot, scoped to the owner. */
export async function getWorkspace(userId: string, id: string): Promise<LoadedWorkspace | null> {
  const { data: row, error } = await supabaseAdminClient
    .from("terragram_workspaces")
    .select("id, name, mode, cloud, tool, updated_at, user_id")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (error || !row) return null;

  const { data: snapshot } = await supabaseAdminClient
    .from("terragram_workspace_snapshots")
    .select("model, transcript")
    .eq("workspace_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    summary: toSummary(row as WorkspaceRow),
    model: parseModel(snapshot?.model),
    transcript: parseTranscript(snapshot?.transcript),
  };
}

/**
 * Append a model snapshot with the conversation that produced it, bump the
 * workspace, and prune anything past the retention limit in the same call — so the
 * table is bounded by construction rather than by a cron job nobody runs.
 */
export async function saveSnapshot(
  userId: string,
  id: string,
  model: InfraModel,
  transcript: TranscriptTurn[] = [],
): Promise<boolean> {
  if (!(await ownsWorkspace(userId, id))) return false;

  const { error } = await supabaseAdminClient.from("terragram_workspace_snapshots").insert({
    workspace_id: id,
    model: model as unknown as Json,
    transcript: transcript as unknown as Json,
  });
  if (error) return false;

  await supabaseAdminClient
    .from("terragram_workspaces")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);

  await pruneSnapshots(id);
  return true;
}

/** Delete snapshots beyond the newest `SNAPSHOT_LIMIT` for a workspace. */
async function pruneSnapshots(workspaceId: string): Promise<void> {
  const { data } = await supabaseAdminClient
    .from("terragram_workspace_snapshots")
    .select("id")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(SNAPSHOT_LIMIT, SNAPSHOT_LIMIT + 200);
  if (!data || data.length === 0) return;
  await supabaseAdminClient
    .from("terragram_workspace_snapshots")
    .delete()
    .in("id", data.map((row) => row.id));
}

/** The workspace's snapshot history, newest first. */
export async function listSnapshots(userId: string, id: string): Promise<SnapshotSummary[]> {
  if (!(await ownsWorkspace(userId, id))) return [];
  const { data } = await supabaseAdminClient
    .from("terragram_workspace_snapshots")
    .select("id, created_at, model")
    .eq("workspace_id", id)
    .order("created_at", { ascending: false })
    .limit(SNAPSHOT_LIMIT);
  if (!data) return [];
  return data.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    nodeCount: parseModel(row.model).nodes.length,
  }));
}

/** Load one historical snapshot. Restoring is non-destructive: the caller saves it
 *  forward as a new head rather than deleting what came after. */
export async function getSnapshot(
  userId: string,
  workspaceId: string,
  snapshotId: string,
): Promise<{ model: InfraModel; transcript: TranscriptTurn[] } | null> {
  if (!(await ownsWorkspace(userId, workspaceId))) return null;
  const { data } = await supabaseAdminClient
    .from("terragram_workspace_snapshots")
    .select("model, transcript")
    .eq("id", snapshotId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) return null;
  return { model: parseModel(data.model), transcript: parseTranscript(data.transcript) };
}

/** Update a workspace's own settings — mode, target cloud, tool, name. */
export async function updateWorkspace(
  userId: string,
  id: string,
  patch: { name?: string; mode?: WorkspaceMode; cloud?: "azure" | "aws"; tool?: TerraformTool },
): Promise<boolean> {
  const update: Database["public"]["Tables"]["terragram_workspaces"]["Update"] = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.mode !== undefined) update.mode = patch.mode;
  if (patch.cloud !== undefined) update.cloud = patch.cloud;
  if (patch.tool !== undefined) update.tool = patch.tool;
  if (Object.keys(update).length === 0) return true;

  const { error } = await supabaseAdminClient
    .from("terragram_workspaces")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId);
  return !error;
}

/* ---------------------------------------------------------------- settings -- */

export async function getSettings(userId: string): Promise<WorkspaceSettings> {
  const { data } = await supabaseAdminClient
    .from("terragram_user_settings")
    .select("settings")
    .eq("user_id", userId)
    .maybeSingle();
  return parseSettings(data?.settings);
}

export async function saveSettings(
  userId: string,
  settings: WorkspaceSettings,
): Promise<boolean> {
  // Upsert rather than update: the row is created on first save, so nothing has to
  // provision a settings row alongside the account. `users` is the Infraweaver base
  // schema's table and Terragram does not write to it.
  const { error } = await supabaseAdminClient.from("terragram_user_settings").upsert(
    {
      user_id: userId,
      settings: settings as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  return !error;
}

/* ------------------------------------------------------------ evidence log -- */

export type StoredReceipt = {
  id: string;
  contentHash: string;
  signed: boolean;
  approver: string;
  approvedAt: string;
  cloud: string;
  createdAt: string;
};

/** Record an approved receipt. Failure never blocks the approval — the reviewer
 *  still gets their bundle; what is lost is the server-side copy. */
export async function saveReceipt(
  userId: string,
  workspaceId: string | null,
  receipt: EvidenceReceipt,
  model: InfraModel,
  files: TerraformFile[],
): Promise<string | null> {
  if (workspaceId !== null && !(await ownsWorkspace(userId, workspaceId))) return null;
  const { data, error } = await supabaseAdminClient
    .from("terragram_evidence_bundles")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      content_hash: receipt.contentHash,
      signature: receipt.signature,
      key_id: receipt.keyId,
      engine: receipt.engine,
      cloud: receipt.cloud,
      tool: receipt.tool,
      approver: receipt.approver,
      approved_at: receipt.approvedAt,
      explanation: receipt.explanation,
      model: model as unknown as Json,
      plan: files as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id;
}

/** Prior receipts for a workspace, newest first. */
export async function listReceipts(
  userId: string,
  workspaceId: string,
): Promise<StoredReceipt[]> {
  const { data } = await supabaseAdminClient
    .from("terragram_evidence_bundles")
    .select("id, content_hash, signature, approver, approved_at, cloud, created_at")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data) return [];
  return data.map((row) => ({
    id: row.id,
    contentHash: row.content_hash,
    signed: row.signature !== null,
    approver: row.approver,
    approvedAt: row.approved_at,
    cloud: row.cloud,
    createdAt: row.created_at,
  }));
}

/* ------------------------------------------------------------- share links -- */

export type ShareLink = {
  id: string;
  /** Only returned at creation — the database stores the hash, never the token. */
  token?: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a read-only review link. The token is shown once and stored only as a hash,
 *  so a leaked database row cannot be used to open the workspace. */
export async function createShareLink(
  userId: string,
  workspaceId: string,
): Promise<ShareLink | null> {
  if (!(await ownsWorkspace(userId, workspaceId))) return null;
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabaseAdminClient
    .from("terragram_share_links")
    .insert({
      workspace_id: workspaceId,
      created_by: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
    })
    .select("id, expires_at, revoked_at, created_at")
    .single();
  if (error || !data) return null;

  return {
    id: data.id,
    token,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
    createdAt: data.created_at,
  };
}

export async function listShareLinks(
  userId: string,
  workspaceId: string,
): Promise<ShareLink[]> {
  const { data } = await supabaseAdminClient
    .from("terragram_share_links")
    .select("id, expires_at, revoked_at, created_at")
    .eq("created_by", userId)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data) return [];
  return data.map((row) => ({
    id: row.id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function revokeShareLink(userId: string, linkId: string): Promise<boolean> {
  const { error } = await supabaseAdminClient
    .from("terragram_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", linkId)
    .eq("created_by", userId);
  return !error;
}

/**
 * Resolve a share token to a read-only view. Returns null for an unknown, revoked or
 * expired token — every failure looks identical from the outside, so a token cannot
 * be probed for existence.
 */
export async function resolveShareLink(token: string): Promise<{
  summary: WorkspaceSummary;
  model: InfraModel;
  receipts: StoredReceipt[];
} | null> {
  if (!token) return null;
  const { data: link } = await supabaseAdminClient
    .from("terragram_share_links")
    .select("workspace_id, created_by, expires_at, revoked_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (!link) return null;

  const { data: row } = await supabaseAdminClient
    .from("terragram_workspaces")
    .select("id, name, mode, cloud, tool, updated_at, user_id")
    .eq("id", link.workspace_id)
    .maybeSingle();
  if (!row || !shareLinkOpens(link, row.user_id)) return null;

  const { data: snapshot } = await supabaseAdminClient
    .from("terragram_workspace_snapshots")
    .select("model")
    .eq("workspace_id", link.workspace_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const receipts = await listReceipts(row.user_id, link.workspace_id);

  return {
    summary: toSummary(row as WorkspaceRow),
    model: parseModel(snapshot?.model),
    receipts,
  };
}
