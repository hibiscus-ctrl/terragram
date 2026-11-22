// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { gzipSync } from "node:zlib";

import { ActionError, type Host, type Workflow } from "./workflow.ts";

/**
 * Sending the receipt bundle to a control plane.
 *
 * The job proves where it runs with GitHub's own identity token (the workflow needs
 * `id-token: write`), trades it at `POST /api/v1/session` for a short-lived token pinned to this
 * repository, and sends the bundle's files to `POST /api/v1/ingest/diagram` with that token. No
 * long-lived secret is involved on either side, and neither token is ever written to the log:
 * both are registered for masking the moment they are received.
 *
 * The control plane re-checks everything it is sent (the receipt's schema, the content hash
 * recomputed from the model and the plan, the signatures), so a refusal here is its verdict and
 * is reported as it gave it. The content hash is the idempotency key on its side, so sending the
 * same bundle again is safe and is answered as a replay.
 */

/** Every request gives up after this long: a hung control plane must not hold the runner. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Attempts at each request that failed in a way a retry can fix (a 429, a 5xx, or no answer). */
const ATTEMPTS = 3;

/** The wire id of the document sent. */
const BUNDLE_SCHEMA = "diagram.bundle/v1";

/** The audience the control plane's session endpoint accepts unless it is configured otherwise. */
export const DEFAULT_AUDIENCE = "infraharvest-api";

type BundleFile = { name: string; content: string };

export type UploadRequest = {
  /** The `control-plane-url` input. */
  url: string;
  /** The `control-plane-audience` input: what the identity token is issued for. */
  audience: string;
  /** The model file's path in the repository, with forward slashes. */
  modelPath: string;
  /** The commit the workflow ran on (`GITHUB_SHA`), as the Action reads it. */
  sha: string | undefined;
  /** The bundle's files, exactly as written to `_diagram/`. */
  files: readonly BundleFile[];
};

export type UploadResult = {
  snapshotId: string;
  workspaceId: string;
  /** True when this bundle had been kept before and nothing new was stored. */
  replayed: boolean;
};

type Seams = {
  host: Pick<Host, "env" | "fetch">;
  workflow: Pick<Workflow, "mask" | "log">;
  /** Waits between attempts; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The control plane's base address: https, or http only for a machine's own loopback (a local
 * control plane under development), with no credentials, query or fragment in it. A path prefix is kept.
 */
function controlPlaneBase(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ActionError(`control-plane-url "${raw}" is not a URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new ActionError("control-plane-url must be an https:// address");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ActionError("control-plane-url must be an address only: no credentials, query or fragment");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** What a control plane said was wrong, as one short plain line: it may echo anything, so it is bounded and stripped of control characters. */
function said(body: unknown): string {
  const text = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : "";
  const plain = Array.from(text, (char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char)).join("");
  return plain.replace(/ {2,}/g, " ").trim().slice(0, 300);
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** One request with a timeout and retries for what a retry can fix; the final response is returned, a persistent failure to reach it is an error. */
async function send(seams: Seams, what: string, make: () => Promise<Response>): Promise<Response> {
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastProblem = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await make();
      if (response.status !== 429 && response.status < 500) return response;
      lastProblem = `answered ${response.status}`;
      if (attempt === ATTEMPTS) return response;
    } catch (error) {
      lastProblem = `could not be reached (${(error as Error).name === "TimeoutError" ? "timed out" : "network error"})`;
      if (attempt === ATTEMPTS) throw new ActionError(`${what} ${lastProblem} after ${ATTEMPTS} attempts`);
    }
    seams.workflow.log(`${what} ${lastProblem}; trying again`);
    await sleep(500 * attempt);
  }
  throw new ActionError(`${what} ${lastProblem}`);
}

/** The job's GitHub identity token, for this audience. */
async function identityToken(seams: Seams, audience: string): Promise<string> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken } = seams.host.env;
  if (!requestUrl || !requestToken) {
    throw new ActionError(
      "uploading needs the job's identity token, which GitHub only issues when the job has `permissions: id-token: write` (a pull request from a fork never gets one)",
    );
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await send(seams, "GitHub's identity-token endpoint", () =>
    seams.host.fetch(url, {
      headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
  const body = (await json(response)) as { value?: unknown } | null;
  if (!response.ok || typeof body?.value !== "string" || body.value === "") {
    throw new ActionError(`GitHub would not issue an identity token for the audience "${audience}" (status ${response.status})`);
  }
  seams.workflow.mask(body.value);
  return body.value;
}

/** The short-lived, repository-pinned token the control plane gives for the identity token. */
async function sessionToken(seams: Seams, base: string, identity: string): Promise<string> {
  const response = await send(seams, "the control plane's session endpoint", () =>
    seams.host.fetch(`${base}/api/v1/session`, {
      method: "POST",
      headers: { "x-github-oidc-token": identity, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
  const body = (await json(response)) as { token?: unknown } | null;
  if (!response.ok) {
    throw new ActionError(`the control plane refused the job's identity (status ${response.status}): ${said(body) || "no reason given"}`);
  }
  if (typeof body?.token !== "string" || body.token === "") {
    throw new ActionError("the control plane's session answer carried no token");
  }
  seams.workflow.mask(body.token);
  return body.token;
}

/**
 * Upload the bundle. Throws an `ActionError` that says what to fix when anything fails: no identity
 * token, an address that is not usable, a refused identity, a bundle the control plane would not keep.
 */
export async function uploadBundle(request: UploadRequest, seams: Seams): Promise<UploadResult> {
  const base = controlPlaneBase(request.url);
  const identity = await identityToken(seams, request.audience);
  const token = await sessionToken(seams, base, identity);

  const document = {
    schema: BUNDLE_SCHEMA,
    model_path: request.modelPath,
    ...(request.sha && /^[0-9a-f]{7,64}$/.test(request.sha) ? { sha: request.sha } : {}),
    entries: request.files.map((file) => ({ name: file.name, content: file.content })),
  };
  const body = gzipSync(JSON.stringify(document));

  const response = await send(seams, "the control plane's ingest endpoint", () =>
    seams.host.fetch(`${base}/api/v1/ingest/diagram`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
        accept: "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  );
  const answer = (await json(response)) as {
    snapshot_id?: unknown;
    workspace_id?: unknown;
    replayed?: unknown;
  } | null;
  if (!response.ok) {
    const reason = said(answer) || "no reason given";
    const hint =
      response.status === 402
        ? " (keeping uploaded approvals is part of the hosted evidence plan)"
        : response.status === 403
          ? " (the token must be a repository's run token, from this Action's identity)"
          : "";
    throw new ActionError(`the control plane did not keep the bundle (status ${response.status}): ${reason}${hint}`);
  }
  if (typeof answer?.snapshot_id !== "string" || typeof answer.workspace_id !== "string") {
    throw new ActionError(`the control plane answered ${response.status} without saying what it kept`);
  }
  return { snapshotId: answer.snapshot_id, workspaceId: answer.workspace_id, replayed: answer.replayed === true };
}
