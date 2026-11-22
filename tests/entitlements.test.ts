// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the private-repo monetization rule — now load-bearing across the
 * report ingest (gates persistence + returns 402), the per-repo + org evidence
 * exports, and the dashboard lock. Pure — run with
 * `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  capabilitiesForTier,
  isRepoLocked,
  resolveEntitlements,
  tierFromStripe,
} from "../src/features/billing/entitlements.ts";

describe("isRepoLocked (capability-based)", () => {
  const free = { privateRepos: false };
  const paid = { privateRepos: true };

  it("locks a PRIVATE repo without the privateRepos capability", () => {
    assert.equal(isRepoLocked({ private: true }, free), true);
  });

  it("never locks a public repo, with or without the capability", () => {
    assert.equal(isRepoLocked({ private: false }, free), false);
    assert.equal(isRepoLocked({ private: false }, paid), false);
  });

  it("does not lock a private repo when entitled", () => {
    assert.equal(isRepoLocked({ private: true }, paid), false);
  });

  it("treats unknown visibility (null) as not-locked — never paywall an unconfirmed repo", () => {
    assert.equal(isRepoLocked({ private: null }, free), false);
  });

  it("enterprise caps unlock private repos", () => {
    assert.equal(isRepoLocked({ private: true }, capabilitiesForTier("enterprise")), false);
  });
});

describe("tierFromStripe", () => {
  it("maps crosswalk_tier to a tier (Free/Team/Enterprise — managed models are not a tier)", () => {
    assert.equal(tierFromStripe(null), "free");
    assert.equal(tierFromStripe("team"), "team");
    assert.equal(tierFromStripe("enterprise"), "enterprise");
    assert.equal(tierFromStripe("TEAM"), "team"); // case-insensitive
  });
});

describe("capabilitiesForTier", () => {
  it("gates private repos + the rest at team; free unlocks nothing hosted", () => {
    assert.equal(capabilitiesForTier("free").privateRepos, false);
    assert.equal(capabilitiesForTier("free").fullCrosswalk, false);
    assert.equal(capabilitiesForTier("team").privateRepos, true);
    assert.equal(capabilitiesForTier("team").fullCrosswalk, true);
    assert.equal(capabilitiesForTier("team").auditorRole, true);
    assert.equal(capabilitiesForTier("enterprise").sso, true);
  });
});

describe("resolveEntitlements", () => {
  it("derives caps from the org plan/tier", () => {
    const e = resolveEntitlements({ plan: "payg", crosswalk_tier: "team" });
    assert.equal(e.tier, "team");
    assert.equal(e.capabilities.fullCrosswalk, true);
  });

  it("defaults to the free tier for an org with no crosswalk tier", () => {
    const e = resolveEntitlements({ plan: "none", crosswalk_tier: null });
    assert.equal(e.tier, "free");
    assert.equal(e.capabilities.fullCrosswalk, false);
  });
});
