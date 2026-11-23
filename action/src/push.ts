// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";

import type { Host } from "./workflow.ts";

type PushPayload = { ref?: unknown; repository?: { default_branch?: unknown } };

function readPushPayload(path: string | undefined): PushPayload | null {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PushPayload | null;
  } catch {
    return null;
  }
}

/**
 * Why a `push` run's model is not the approved one, or null when it is: the push is to the
 * repository's default branch. The branch name comes from the event payload the runner wrote
 * (`repository.default_branch`) and the pushed ref from the same file, so a branch named like
 * the default one under another ref (`refs/tags/main`) is not mistaken for it. A payload that
 * cannot be read says nothing about the branch, so the answer is then "not approved".
 */
export function pushSkipReason(host: Host): string | null {
  const payload = readPushPayload(host.env.GITHUB_EVENT_PATH);
  const ref = payload?.ref;
  const defaultBranch = payload?.repository?.default_branch;
  if (typeof ref !== "string" || typeof defaultBranch !== "string" || defaultBranch === "") {
    return "the bundle was not uploaded: the push event does not say which branch was pushed or which is the default branch.";
  }
  if (ref === `refs/heads/${defaultBranch}`) return null;
  return `the bundle was not uploaded: this push is to ${JSON.stringify(ref)}, not the default branch (${JSON.stringify(defaultBranch)}). Upload from a push to the default branch.`;
}
