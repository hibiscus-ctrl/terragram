// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { encryptionKeyFromEnv, openToken, sealToken } from "../src/features/git/crypto.ts";

describe("git token sealing", () => {
  const key = randomBytes(32);

  it("round-trips a token and never stores it in the clear", () => {
    const sealed = sealToken("ghu_secret-token-value", key);
    assert.ok(!sealed.includes("secret"), "the sealed form must not contain the plaintext");
    assert.match(sealed, /^v1\./);
    assert.equal(openToken(sealed, key), "ghu_secret-token-value");
  });

  it("produces a different ciphertext each time (fresh IV)", () => {
    assert.notEqual(sealToken("same", key), sealToken("same", key));
  });

  it("refuses a token sealed under another key", () => {
    const sealed = sealToken("token", key);
    assert.throws(() => openToken(sealed, randomBytes(32)));
  });

  it("refuses a tampered ciphertext", () => {
    const sealed = sealToken("token", key);
    const [v, iv, ct, tag] = sealed.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = (flipped[0]! + 1) & 0xff;
    assert.throws(() => openToken([v, iv, flipped.toString("base64url"), tag].join("."), key));
  });

  it("reads a 32-byte base64 key from the environment and rejects a wrong size", () => {
    assert.equal(encryptionKeyFromEnv(undefined), null);
    assert.equal(encryptionKeyFromEnv("  "), null);
    assert.equal(encryptionKeyFromEnv(key.toString("base64"))?.equals(key), true);
    assert.throws(() => encryptionKeyFromEnv(randomBytes(16).toString("base64")), /32 bytes/);
  });
});
