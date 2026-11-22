// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type { ComposeResult } from "terragram-engine/engine";
import type { ManagedModelId } from "terragram-engine/managed-models";
import { EMPTY_MODEL, type InfraModel } from "terragram-engine/model";
import { translateWithFallback } from "terragram-engine/translate";

import { logger } from "@/libs/log";

import { isManagedInferenceConfigured, type MintLedger, runManagedCompose } from "./inference.ts";

export { translateRequestSchema } from "terragram-engine/translate";

const log = logger("workspace/translate");

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
 * gateway hiccup degrades quality, never availability. (The fallback decision is the
 * engine's `translateWithFallback`; this binds the environment, the gateway and the log.)
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
  const managedOrgId = args.managedOrgId;
  return translateWithFallback({
    prompt: args.prompt,
    prev,
    managed:
      managedOrgId && managedEngineEnabled()
        ? () =>
            runManagedCompose({
              orgId: managedOrgId,
              prompt: args.prompt,
              prev,
              recordMint: args.recordMint,
              ...(args.inferenceModel ? { model: args.inferenceModel } : {}),
            })
        : null,
    log,
  });
}
