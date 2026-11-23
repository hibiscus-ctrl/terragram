// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { type ComposeResult, composeFromPrompt } from "./engine.ts";
import { EMPTY_MODEL, type InfraModel, infraModelSchema } from "./model.ts";
import { type Logger, ManagedCapReachedError } from "./ports.ts";

/** A translate request: a prompt plus the current model. */
export const translateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: infraModelSchema.optional(),
});

/**
 * Translate a plain-English instruction into the model. Tries the managed turn when
 * the host supplies one, and always falls back to the deterministic keyword engine —
 * a gateway hiccup degrades quality, never availability.
 *
 * `managed` is `null` when the host will not run a managed turn (inference off, or
 * the org not entitled): the deterministic engine answers.
 */
export async function translateWithFallback(args: {
  prompt: string;
  prev?: InfraModel;
  managed: (() => Promise<ComposeResult>) | null;
  log: Logger;
}): Promise<ComposeResult> {
  const prev = args.prev ?? EMPTY_MODEL;
  if (args.managed) {
    try {
      return await args.managed();
    } catch (err) {
      // A reached cap is a decision, not a fault — logging it as a failure would bury
      // the one signal that tells an operator why quality dropped. Either way the
      // deterministic engine answers, so the caller keeps working.
      if (err instanceof ManagedCapReachedError) {
        args.log.info("managed spend cap reached; using the deterministic engine");
      } else {
        // The host's logger redacts: a gateway error commonly embeds the request it
        // failed on, `authorization: Bearer tmpx_…` included.
        args.log.error("managed compose failed, falling back to the deterministic engine", { err });
      }
    }
  }
  return composeFromPrompt(args.prompt, prev);
}
