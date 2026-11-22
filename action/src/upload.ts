// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seam for sending a receipt to a control plane.
 *
 * The ingest route does not exist yet, so nothing is sent: the Action accepts
 * `control-plane-url`, says so, and carries on. When the route lands, this is the only
 * module that changes; `run.ts` already calls it with everything an upload needs.
 */

export type UploadRequest = {
  url: string;
  /** Workspace-relative path of the receipt the Action wrote. */
  receiptPath: string;
  contentHash: string;
  signed: boolean;
};

export type UploadResult = { status: "unsupported" } | { status: "sent" };

export async function uploadReceipt(_request: UploadRequest): Promise<UploadResult> {
  return { status: "unsupported" };
}
