// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The managed-models entitlement gate used by BOTH the `tmpx_` mint route and
 * the metering re-check, so a downgrade / opt-out stops billing immediately instead of
 * up to a token-TTL (1h) later. Pure; run with `node --experimental-strip-types --test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { managedEntitled } from "../src/features/billing/managed-entitlement.ts";

describe("managedEntitled", () => {
  it("is true only for a payg org that has not opted out", () => {
    assert.equal(managedEntitled({ plan: "payg", managed_opt_out: false }), true);
  });

  it("is false once the org downgrades off payg (the post-downgrade billing leak)", () => {
    assert.equal(managedEntitled({ plan: "none", managed_opt_out: false }), false);
    assert.equal(managedEntitled({ plan: null, managed_opt_out: false }), false);
  });

  it("is false when the org opted out of managed models, even on payg", () => {
    assert.equal(managedEntitled({ plan: "payg", managed_opt_out: true }), false);
  });

  it("treats a null opt-out flag as not-opted-out", () => {
    assert.equal(managedEntitled({ plan: "payg", managed_opt_out: null }), true);
  });
});
