// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { Host } from "./workflow.ts";
import { type ModelDocument, parseModelDocument } from "./model-file.ts";

/** The pull request a run belongs to, from the event payload the runner wrote. */
export type PullRequest = { number: number; baseSha: string; headSha: string };

const SHA = /^[0-9a-f]{40,64}$/;

export function readPullRequest(host: Host): PullRequest | null {
  const event = host.env.GITHUB_EVENT_NAME;
  const path = host.env.GITHUB_EVENT_PATH;
  if (event !== "pull_request" || !path) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const pr = (payload as { pull_request?: { number?: unknown; base?: { sha?: unknown }; head?: { sha?: unknown } } })
    .pull_request;
  const baseSha = pr?.base?.sha;
  const headSha = pr?.head?.sha;
  if (typeof pr?.number !== "number" || typeof baseSha !== "string" || typeof headSha !== "string") return null;
  if (!SHA.test(baseSha) || !SHA.test(headSha)) return null;
  return { number: pr.number, baseSha, headSha };
}

/**
 * The model file as the pull request's base had it.
 *
 * - `found`: the base version, parsed.
 * - `absent`: the base commit exists but the file did not, so every node is new.
 * - `unavailable`: the base commit is not in the checkout (a shallow clone) or its copy of
 *   the file is not a valid model; the reason says which.
 */
export type BaseModel =
  | { state: "found"; document: ModelDocument }
  | { state: "absent" }
  | { state: "unavailable"; reason: string };

export function readBaseModel(host: Host, root: string, baseSha: string, modelPath: string): BaseModel {
  // `git -c safe.directory` because the runner's user may not own a container job's checkout.
  const git = (args: string[]) => host.git(["-c", `safe.directory=${root}`, ...args], root);
  if (!git(["cat-file", "-e", `${baseSha}^{commit}`]).ok) {
    return {
      state: "unavailable",
      reason: `the base commit ${baseSha.slice(0, 7)} is not in the checkout; use actions/checkout with fetch-depth: 0 (or fetch the base) so the model's history is available`,
    };
  }
  // `./` makes the path relative to the workspace rather than the repository root.
  const spec = `${baseSha}:./${relative(root, modelPath).replaceAll("\\", "/")}`;
  if (!git(["cat-file", "-e", spec]).ok) return { state: "absent" };
  const shown = git(["show", spec]);
  if (!shown.ok) return { state: "unavailable", reason: "git could not read the model file at the base commit" };
  const parsed = parseModelDocument(shown.stdout);
  if (!parsed.ok) return { state: "unavailable", reason: `the base version of the model file is unusable: ${parsed.problem.split("\n")[0]}` };
  return { state: "found", document: parsed.document };
}
