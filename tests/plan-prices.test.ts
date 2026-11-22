/**
 * Unit tests for the crosswalk-tier entitlement rule and the price-classification
 * helpers, keyed on Stripe `lookup_key`s. Pure — run with
 * `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STRIPE_LOOKUP_KEYS } from "../src/config/pricing.ts";
import {
  crosswalkTierFromLookupKeys,
  isTeamBaseLookupKey,
} from "../src/features/billing/plan-prices.ts";

const LK = STRIPE_LOOKUP_KEYS;

describe("crosswalkTierFromLookupKeys", () => {
  it("grants team when a team base price is on the subscription", () => {
    assert.equal(crosswalkTierFromLookupKeys([LK.teamMonthly, LK.managedCost], null), "team");
  });

  it("matches the annual team price too", () => {
    assert.equal(crosswalkTierFromLookupKeys([LK.teamAnnual], null), "team");
  });

  it("grants nothing for a PAYG / managed-only subscription", () => {
    assert.equal(crosswalkTierFromLookupKeys([LK.payg, LK.managedCost], null), null);
  });

  it("drops team when the subscription no longer carries a team price", () => {
    assert.equal(crosswalkTierFromLookupKeys([], "team"), null);
  });

  it("preserves an out-of-band enterprise tier (case-insensitive), never clobbers it", () => {
    assert.equal(crosswalkTierFromLookupKeys([LK.payg], "enterprise"), "enterprise");
    assert.equal(crosswalkTierFromLookupKeys([], "Enterprise"), "enterprise");
  });

  it("ignores null/undefined lookup keys (a manually-created price without one)", () => {
    assert.equal(crosswalkTierFromLookupKeys([null, undefined], null), null);
    assert.equal(crosswalkTierFromLookupKeys([null, LK.teamMonthly], null), "team");
  });
});

describe("isTeamBaseLookupKey", () => {
  it("team base = the banded monthly/annual prices only (not PAYG)", () => {
    assert.equal(isTeamBaseLookupKey(LK.teamMonthly), true);
    assert.equal(isTeamBaseLookupKey(LK.teamAnnual), true);
    assert.equal(isTeamBaseLookupKey(LK.payg), false);
    assert.equal(isTeamBaseLookupKey(null), false);
  });
});
