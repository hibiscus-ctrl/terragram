// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { composeFromPrompt, type ComposeResult } from "terragram-engine/engine";

/**
 * The seam for inference.
 *
 * `terragram generate --prompt` turns a brief into a model through a `Composer`. The
 * only one here is the engine's deterministic, keyword-driven translator: no network,
 * no key, the same answer every time. Managed inference is a second `Composer` that
 * wraps the engine's `runManagedCompose` around a `ModelClient` (the port in
 * `terragram-engine/ports`), binds credentials and a spend cap, and falls back to this
 * one when the budget is spent. It is not part of this CLI yet, so `composerFor` has
 * one answer; it is the single place a flag or an environment variable will choose.
 */
export interface Composer {
  compose(prompt: string): Promise<ComposeResult>;
}

const deterministicComposer: Composer = {
  compose: async (prompt) => composeFromPrompt(prompt),
};

export function composerFor(): Composer {
  return deterministicComposer;
}
