// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_AUDIENCE } from "./upload.ts";
import { ActionError } from "./workflow.ts";

type Mode = "check" | "write";

export type Inputs = {
  model: string;
  terraformDir: string;
  mode: Mode;
  /** The comment input as written; a comment is posted only on a pull request. */
  comment: boolean;
  signingKey: string | undefined;
  controlPlaneUrl: string | undefined;
  /** What the identity token sent to the control plane is issued for. */
  controlPlaneAudience: string;
  githubToken: string | undefined;
};

/** The runner passes input `terraform-dir` as `INPUT_TERRAFORM-DIR` (upper-cased, hyphen kept). */
function input(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`]?.trim();
  return value ? value : undefined;
}

export function readInputs(env: Readonly<Record<string, string | undefined>>): Inputs {
  const mode = input(env, "mode") ?? "check";
  if (mode !== "check" && mode !== "write") {
    throw new ActionError(`input mode must be "check" or "write" (got "${mode}")`);
  }
  const comment = input(env, "comment") ?? "true";
  if (comment !== "true" && comment !== "false") {
    throw new ActionError(`input comment must be "true" or "false" (got "${comment}")`);
  }
  return {
    model: input(env, "model") ?? "diagram.json",
    terraformDir: input(env, "terraform-dir") ?? "infra/",
    mode,
    comment: comment === "true",
    signingKey: input(env, "signing-key"),
    controlPlaneUrl: input(env, "control-plane-url"),
    controlPlaneAudience: input(env, "control-plane-audience") ?? DEFAULT_AUDIENCE,
    githubToken: input(env, "github-token"),
  };
}

/**
 * Resolve a path the workflow gave us against the workspace, refusing one that leaves it:
 * the Action reads and writes only inside the checked-out repository.
 */
export function resolveInside(root: string, path: string, what: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new ActionError(`${what} "${path}" is outside the workspace`);
  }
  return target;
}
