// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

import type { Signer } from "terragram-engine/ports";

import { ActionError } from "./workflow.ts";

/**
 * The signing-key input as a `Signer` for the engine: an Ed25519 private key in PKCS#8
 * PEM form, either as the PEM itself or base64-encoded (the two spellings the app's
 * own signing key is accepted in). The engine only ever sees the `Signer`; the key
 * stays in this closure and never reaches a log, an output or the bundle.
 */

/** Every secret-bearing line of a key, for `::add-mask::` (the runner masks per line). */
export function maskableParts(raw: string): string[] {
  const text = raw.trim();
  const parts = new Set<string>([text]);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("-----")) parts.add(trimmed);
  }
  // The base64 body without its line breaks is the same secret in another spelling.
  const body = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("-----"))
    .join("")
    .trim();
  if (body.length > 0) parts.add(body);
  return [...parts];
}

export function loadSigner(raw: string, signedAt: string): Signer {
  const value = raw.trim();
  const pem = value.includes("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    // The runtime's message can quote the decoder's view of the input, so it is not passed on.
    throw new ActionError("signing-key is not a private key in PEM (PKCS#8) form");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new ActionError("signing-key must be an Ed25519 private key");
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    keyId: `terragram-action-${createHash("sha256").update(der).digest("hex").slice(0, 12)}`,
    signedAt,
    publicKey: der.toString("base64"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (bytes) => sign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64"),
  };
}
