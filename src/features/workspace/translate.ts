// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { composeFromPrompt, type ComposeResult } from "./engine.ts";
import {
  isManagedInferenceConfigured,
  ManagedCapReachedError,
  type MintLedger,
  runManagedCompose,
} from "./inference.ts";
import { logger } from "@/libs/log";
import type { ManagedModelId } from "./managed-models.ts";
import { EMPTY_MODEL, type InfraModel, infraModelSchema } from "./model.ts";

const log = logger("workspace/translate");

/** Body of POST /api/workspace/translate — a prompt plus the current model. */
export const translateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: infraModelSchema.optional(),
});

/**
 * Managed inference is opt-in per deployment: `WORKSPACE_ENGINE=managed` AND the
 * EU model proxy configured. Off by default so local dev and CI stay deterministic
 * and keyless.
 */
export function managedEngineEnabled(): boolean {
  return process.env.WORKSPACE_ENGINE === "managed" && isManagedInferenceConfigured();
}

/**
 * Translate a plain-English instruction into the model. Uses managed UK inference
 * when enabled, and always falls back to the deterministic keyword engine — a
 * gateway hiccup degrades quality, never availability.
 *
 * `managedOrgId` is the org to meter managed inference against, and only an org the
 * caller has ALREADY verified as managed-entitled — pass `null` to force the
 * deterministic engine. Managed Bedrock calls cost real money per invocation, and
 * `recordManagedUsage` refuses to bill a non-entitled org, so minting a token
 * without this gate is unmetered spend.
 */
export async function translateChat(args: {
  managedOrgId: string | null;
  prompt: string;
  prev?: InfraModel;
  /** The caller's chosen managed model. Resolved from their stored settings on the
   *  server — never taken from the request body, because it reaches the proxy. */
  inferenceModel?: ManagedModelId;
  /** Records the mint ledger row when a managed call mints a token. */
  recordMint: MintLedger;
}): Promise<ComposeResult> {
  const prev = args.prev ?? EMPTY_MODEL;
  if (args.managedOrgId && managedEngineEnabled()) {
    try {
      return await runManagedCompose({
        orgId: args.managedOrgId,
        prompt: args.prompt,
        prev,
        recordMint: args.recordMint,
        ...(args.inferenceModel ? { model: args.inferenceModel } : {}),
      });
    } catch (err) {
      // A reached cap is a decision, not a fault — logging it as a failure would bury
      // the one signal that tells an operator why quality dropped. Either way the
      // deterministic engine answers, so the workspace keeps working.
      if (err instanceof ManagedCapReachedError) {
        log.info("managed spend cap reached; using the deterministic engine");
      } else {
        // Redacted: a gateway error commonly embeds the request it failed on,
        // `authorization: Bearer tmpx_…` included.
        log.error("managed compose failed, falling back to the deterministic engine", { err });
      }
    }
  }
  return composeFromPrompt(args.prompt, prev);
}
