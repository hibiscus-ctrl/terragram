// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

describe("Route protection", () => {
  // Every prefix the proxy guards (src/libs/supabase/supabase-middleware-client.ts):
  // the (app) workspace and (dashboard) pages, and the (account) routes.
  const PROTECTED = [
    "/workspace",
    "/workspace/canvas?mode=chat-diagram",
    "/workspace/settings",
    "/billing",
    "/settings",
    "/members",
    "/account",
    "/manage-subscription",
  ];

  it("signed out → every protected page redirects to /login", () => {
    for (const path of PROTECTED) {
      cy.visit(path);
      cy.location("pathname", { timeout: 15000 }).should("eq", "/login");
    }
  });

  it("signed in → each protected page renders its own heading", () => {
    cy.login();
    const pages: [string, string][] = [
      ["/workspace", "What do you want to translate?"],
      ["/workspace/settings", "Workspace settings"],
      ["/billing", "Billing & usage"],
      ["/settings", "Settings"],
      ["/members", "Members"],
    ];
    for (const [path, heading] of pages) {
      cy.visit(path);
      cy.location("pathname").should("eq", path);
      cy.findByRole("heading", { level: 1, name: heading }).should("be.visible");
    }
  });

  it("signed in → /account is the billing page", () => {
    cy.login();
    cy.visit("/account");
    cy.location("pathname", { timeout: 15000 }).should("eq", "/billing");
  });
});
