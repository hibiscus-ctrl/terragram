// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the org RBAC model: the capability matrix and the page-guard
 * verdicts. Pure — run with `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { homeFor, pageVerdict } from "../src/features/account/controllers/page-guards-core.ts";
import {
  allows,
  CAPABILITIES,
  type Capability,
  can,
  isBillingOnly,
  isPrivilegedRole,
  ORG_ROLES,
} from "../src/features/account/controllers/permissions.ts";

describe("the role set", () => {
  it("is the shared enum's four roles — there is no org Owner", () => {
    assert.deepEqual(ORG_ROLES, ["admin", "maintainer", "auditor", "billing_manager"]);
  });
});

describe("can / allows", () => {
  it("gives the Admin every capability", () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      assert.equal(can("admin", capability), true, capability);
    }
  });

  it("gives the Billing Manager billing and nothing else", () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      assert.equal(can("billing_manager", capability), capability === "billing.manage", capability);
    }
  });

  it("gives the Maintainer and the Auditor no account-dashboard capability", () => {
    for (const role of ["maintainer", "auditor"] as const) {
      for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
        assert.equal(can(role, capability), false, `${role}/${capability}`);
      }
    }
  });

  it("allows(capability) is the same decision as can(role, capability)", () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      for (const role of ORG_ROLES) {
        assert.equal(allows(capability)(role), can(role, capability));
      }
    }
  });
});

describe("isPrivilegedRole / isBillingOnly", () => {
  it("only the Admin is privileged (the last-Admin invariant)", () => {
    assert.deepEqual(ORG_ROLES.filter(isPrivilegedRole), ["admin"]);
  });

  it("only the Billing Manager is the billing-only persona", () => {
    assert.deepEqual(ORG_ROLES.filter(isBillingOnly), ["billing_manager"]);
  });
});

describe("pageVerdict", () => {
  it("denies a signed-in user with no membership instead of letting the page render", () => {
    assert.equal(pageVerdict(null, "org.settings"), "/login");
  });

  it("lets a role holding the capability through", () => {
    assert.equal(pageVerdict({ role: "admin" }, "org.settings"), null);
    assert.equal(pageVerdict({ role: "billing_manager" }, "billing.manage"), null);
  });

  it("sends the Billing Manager to Billing and everyone else to the workspace", () => {
    assert.equal(pageVerdict({ role: "billing_manager" }, "org.settings"), "/billing");
    assert.equal(pageVerdict({ role: "maintainer" }, "billing.manage"), "/workspace");
    assert.equal(pageVerdict({ role: "auditor" }, "org.settings"), "/workspace");
  });

  it("never redirects a refused member to a page that refuses them too", () => {
    const pageFor: Record<string, Capability | null> = {
      "/billing": "billing.manage",
      "/workspace": null, // per-user, open to every signed-in user
    };
    for (const role of ORG_ROLES) {
      const home = homeFor(role);
      const needs = pageFor[home];
      assert.ok(needs !== undefined, `${role}: unknown home ${home}`);
      if (needs) assert.equal(can(role, needs), true, `${role} bounces off ${home}`);
    }
  });
});
