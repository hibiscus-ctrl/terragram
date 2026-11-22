// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `constantTimeEqual` guards the proxy's callback secret, the `tmpx_` token
 * signature and the Git OAuth `state`. The properties worth pinning are the ones
 * the hand-rolled compares it replaced got wrong: a length mismatch must answer
 * false (the callback compare short-circuited on length, leaking it), and a
 * multi-byte character must never reach `timingSafeEqual` as a byte-length
 * mismatch, which THROWS — a forged value would become a 500 instead of a 401.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { constantTimeEqual } from "../src/utils/crypto.ts";

describe("constantTimeEqual", () => {
  it("is true for identical strings, including the empty string", () => {
    assert.equal(constantTimeEqual("s3cret-value", "s3cret-value"), true);
    assert.equal(constantTimeEqual("", ""), true);
  });

  it("is false for a different value of the same length", () => {
    assert.equal(constantTimeEqual("s3cret-value", "s3cret-valuf"), false);
  });

  it("is false, not a throw, when the lengths differ", () => {
    assert.equal(constantTimeEqual("short", "a-much-longer-secret"), false);
    assert.equal(constantTimeEqual("", "x"), false);
  });

  it("does not throw when equal .length hides a different byte length", () => {
    // "é" is one UTF-16 unit but two UTF-8 bytes: same .length, different buffers.
    assert.equal("aé".length, "ab".length);
    assert.doesNotThrow(() => constantTimeEqual("aé", "ab"));
    assert.equal(constantTimeEqual("aé", "ab"), false);
  });
});
