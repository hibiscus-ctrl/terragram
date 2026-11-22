// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seams between the engine and whoever embeds it.
 *
 * The engine decides what to ask a model, how to read the answer and what a receipt
 * says; it never reads the environment, mints credentials, meters spend or holds a
 * key. Those belong to the host (a CLI, an Action or any other program), which
 * passes an implementation of each port in.
 */

/** An Anthropic Messages request. The engine builds it; the host decides where it goes. */
export type MessagesRequest = { model: string } & Record<string, unknown>;

/**
 * Sends one Messages request that forces a single tool call, and returns that tool's
 * input (or null when the response carried none). Authentication, spend caps,
 * metering and the transport are the implementation's business.
 *
 * Throw `ManagedCapReachedError` to say "refused: the budget is spent", as distinct
 * from a transport failure.
 */
export interface ModelClient {
  toolCall(request: MessagesRequest): Promise<unknown>;
}

/** Thrown by a `ModelClient` when the org has spent its managed allowance. Distinct
 *  from a transport failure so the caller can tell "we refused" from "the gateway broke". */
export class ManagedCapReachedError extends Error {
  constructor() {
    super("managed-model spend cap reached for this cycle");
    this.name = "ManagedCapReachedError";
  }
}

/**
 * A configured evidence signer: an Ed25519 key the host holds. The engine hands it
 * bytes and gets a detached signature back; the key itself never enters the engine.
 */
export interface Signer {
  keyId: string;
  /** ISO timestamp the host stamps on the signature. */
  signedAt: string;
  /** Base64 SPKI DER of the public half, the form a verifier imports. */
  publicKey: string;
  /** The public half as PEM, the form `infraweaver verify-evidence` takes. */
  publicKeyPem: string;
  /** Detached Ed25519 signature over the exact bytes, base64. */
  sign(bytes: string): string;
}

/** Structured log sink. The host's implementation is responsible for redaction. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
