// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { redirect } from "next/navigation";

import { getAuthenticatedUser } from "@/features/account/controllers/get-authenticated-user";

import type { EngineKind } from "./engine.ts";
import { type Cloud, type InfraModel, infraModelSchema } from "./model.ts";
import { isManagedModelId } from "./managed-models.ts";
import { isWorkspaceMode, MODE_META, type WorkspaceMode } from "./modes.ts";
import { buildBundle, type BundleEntry, type EvidenceReceipt } from "./receipt.ts";
import {
  type WorkspaceSettings,
  workspaceSettingsSchema,
} from "./settings.ts";
import { buildEvidenceReceipt } from "./sign.ts";
import {
  createShareLink,
  createWorkspace,
  getSettings,
  getSnapshot,
  listReceipts,
  listShareLinks,
  listSnapshots,
  revokeShareLink,
  saveReceipt,
  saveSettings,
  saveSnapshot,
  type ShareLink,
  type SnapshotSummary,
  type StoredReceipt,
  type TranscriptTurn,
  updateWorkspace,
} from "./store.ts";
import type { TerraformTool } from "./terraform.ts";
import { templateById, templateModel } from "./templates.ts";

/**
 * Server actions for the workspace. Every one of them re-derives the acting user
 * from the session rather than trusting an id from the client, and every write goes
 * through the ownership-scoped store layer.
 */

function toTool(value: unknown): TerraformTool {
  return value === "opentofu" ? "opentofu" : "terraform";
}

/**
 * Create a workspace from the picker and open it. Falls back to an ephemeral canvas
 * (no id) when persistence is not provisioned, so the picker never dead-ends.
 */
export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login");

  const raw = formData.get("mode");
  const settings = await getSettings(user.id);
  const mode: WorkspaceMode = isWorkspaceMode(typeof raw === "string" ? raw : undefined)
    ? (raw as WorkspaceMode)
    : settings.defaultMode;

  const rawTemplate = formData.get("template");
  const template =
    typeof rawTemplate === "string" ? templateById(rawTemplate) : undefined;

  const id = await createWorkspace(user.id, {
    name: template ? template.name : `New ${MODE_META[mode].title}`,
    mode,
    cloud: settings.defaultCloud,
    tool: settings.defaultTool,
  });

  // A template seeds its model as the workspace's first snapshot, so the canvas
  // opens on it and a reload finds it there rather than an empty graph.
  if (id && template) {
    await saveSnapshot(user.id, id, templateModel(template), []);
  }

  const query = new URLSearchParams({ mode });
  if (id) query.set("id", id);
  if (template && !id) query.set("template", template.id);
  redirect(`/workspace/canvas?${query.toString()}`);
}

/** Persist the current model and conversation as a new snapshot. */
export async function saveWorkspaceAction(
  id: string,
  model: InfraModel,
  transcript: TranscriptTurn[] = [],
): Promise<{ ok: boolean }> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false };
  const parsed = infraModelSchema.safeParse(model);
  if (!parsed.success) return { ok: false };
  return { ok: await saveSnapshot(user.id, id, parsed.data, transcript.slice(-100)) };
}

/**
 * Confirm the review gate: build the signed evidence receipt, store it as the audit
 * record, and return it with the downloadable bundle.
 *
 * The plan is re-emitted server-side from (model, cloud) rather than trusting a
 * client-supplied plan, so the bytes that are hashed are the bytes this server would
 * generate. Storage failure does not fail the approval — the reviewer still gets a
 * verifiable bundle; what is lost is our copy of it.
 */
export async function generateEvidenceAction(args: {
  model: InfraModel;
  cloud: Cloud;
  engine: EngineKind;
  /** The managed model the turn ran on, for the receipt's provenance. Validated
   *  here like `engine` is, and like `engine` it is the client's assertion about
   *  its own turn — it names what produced the plan, it never selects a model. */
  inferenceModel?: string;
  tool?: TerraformTool;
  workspaceId?: string;
}): Promise<{ receipt: EvidenceReceipt; bundle: BundleEntry[]; stored: boolean } | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;

  const parsed = infraModelSchema.safeParse(args.model);
  if (!parsed.success) return null;

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const approver =
    (typeof meta.full_name === "string" && meta.full_name) || user.email || user.id;
  const cloud: Cloud = args.cloud === "aws" ? "aws" : "azure";
  const engine: EngineKind = args.engine === "managed" ? "managed" : "deterministic";
  const tool = toTool(args.tool);

  const { receipt, terraform, attestation } = await buildEvidenceReceipt(
    parsed.data,
    cloud,
    engine,
    approver,
    new Date().toISOString(),
    {
      tool,
      ...(isManagedModelId(args.inferenceModel) ? { inferenceModel: args.inferenceModel } : {}),
    },
  );

  const stored = args.workspaceId
    ? (await saveReceipt(user.id, args.workspaceId, receipt, parsed.data, terraform.files)) !== null
    : false;

  return {
    receipt,
    bundle: buildBundle(receipt, parsed.data, terraform.files, attestation),
    stored,
  };
}

/** Rename a workspace. */
export async function renameWorkspaceAction(id: string, name: string): Promise<{ ok: boolean }> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false };
  const trimmed = name.trim().slice(0, 120);
  if (!trimmed) return { ok: false };
  return { ok: await updateWorkspace(user.id, id, { name: trimmed }) };
}

/** Persist a workspace's own mode, target cloud or tool when the canvas changes it. */
export async function updateWorkspaceAction(
  id: string,
  patch: { mode?: WorkspaceMode; cloud?: Cloud; tool?: TerraformTool },
): Promise<{ ok: boolean }> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false };
  return {
    ok: await updateWorkspace(user.id, id, {
      ...(patch.mode && isWorkspaceMode(patch.mode) ? { mode: patch.mode } : {}),
      ...(patch.cloud ? { cloud: patch.cloud === "aws" ? "aws" : "azure" } : {}),
      ...(patch.tool ? { tool: toTool(patch.tool) } : {}),
    }),
  };
}

/* ----------------------------------------------------------------- history -- */

export async function listSnapshotsAction(id: string): Promise<SnapshotSummary[]> {
  const user = await getAuthenticatedUser();
  if (!user) return [];
  return listSnapshots(user.id, id);
}

/** Load a historical snapshot. Restoring is non-destructive — the client saves the
 *  restored model forward as a new head, so nothing in the history is ever lost. */
export async function restoreSnapshotAction(
  workspaceId: string,
  snapshotId: string,
): Promise<{ model: InfraModel; transcript: TranscriptTurn[] } | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;
  return getSnapshot(user.id, workspaceId, snapshotId);
}

/* ---------------------------------------------------------------- settings -- */

export async function saveSettingsAction(
  settings: unknown,
): Promise<{ ok: boolean; settings?: WorkspaceSettings }> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false };
  const parsed = workspaceSettingsSchema.safeParse(settings);
  if (!parsed.success) return { ok: false };
  const ok = await saveSettings(user.id, parsed.data);
  return ok ? { ok, settings: parsed.data } : { ok };
}

/* ------------------------------------------------------------- share links -- */

export async function createShareLinkAction(workspaceId: string): Promise<ShareLink | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;
  return createShareLink(user.id, workspaceId);
}

export async function listShareLinksAction(workspaceId: string): Promise<ShareLink[]> {
  const user = await getAuthenticatedUser();
  if (!user) return [];
  return listShareLinks(user.id, workspaceId);
}

export async function revokeShareLinkAction(linkId: string): Promise<{ ok: boolean }> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false };
  return { ok: await revokeShareLink(user.id, linkId) };
}

/* ------------------------------------------------------------------ receipts -- */

export async function listReceiptsAction(workspaceId: string): Promise<StoredReceipt[]> {
  const user = await getAuthenticatedUser();
  if (!user) return [];
  return listReceipts(user.id, workspaceId);
}
