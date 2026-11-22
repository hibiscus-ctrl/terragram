// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

describe("Sign up", () => {
  it("renders the signup form and links back to sign in", () => {
    cy.visit("/signup");
    cy.findByRole("heading", { name: "Create your Terragram account" }).should("be.visible");
    cy.findByLabelText("Email").should("be.visible");
    cy.findByLabelText("Password").should("have.attr", "placeholder", "At least 8 characters");
    cy.findByRole("button", { name: "Create account" }).should("be.visible");
    cy.findByRole("link", { name: "Sign in" }).should("have.attr", "href", "/login");
  });

  it("refuses a short password client-side, without creating anything", () => {
    cy.visit("/signup");
    cy.hydrated("form");
    cy.findByLabelText("Email").type(`no-account-${Date.now()}@example.invalid`);
    cy.findByLabelText("Password").type("short", { log: false });
    cy.findByRole("button", { name: "Create account" }).click();
    cy.contains("#password-error", "Password must be at least 8 characters.").should("be.visible");
    cy.location("pathname").should("eq", "/signup");
  });

  it("an existing account is sent to sign in, never told apart from a new one", () => {
    // Opt-in: this posts a real signup to the shared Supabase project. The e2e
    // user exists already, so nothing new is created; but the request is real.
    if (!Cypress.expose("RUN_SIGNUP")) {
      cy.log("set CYPRESS_RUN_SIGNUP=1 to run");
      return;
    }
    const email = Cypress.expose("E2E_USER_EMAIL") as string;
    cy.task("seedUser", { email, password: Cypress.expose("E2E_USER_PASSWORD") as string });
    cy.visit("/signup");
    cy.hydrated("form");
    cy.findByLabelText("Email").type(email);
    cy.findByLabelText("Password").type("another-long-password", { log: false });
    cy.findByRole("button", { name: "Create account" }).click();
    cy.location("pathname", { timeout: 20000 }).should("eq", "/login");
  });
});
