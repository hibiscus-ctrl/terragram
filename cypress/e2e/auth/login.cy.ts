// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// The login surface end to end. (cy.login seeds the e2e user on first use.)

describe("Login", () => {
  const email = Cypress.expose("E2E_USER_EMAIL") as string;
  const password = Cypress.expose("E2E_USER_PASSWORD") as string;

  it("valid credentials → lands in the workspace", () => {
    cy.task("seedUser", { email, password });
    cy.visit("/login");
    cy.findByRole("heading", { name: "Sign in to Terragram" }).should("be.visible");
    cy.hydrated("form");
    cy.findByLabelText("Email").type(email);
    cy.findByLabelText("Password").type(password, { log: false });
    cy.findByRole("button", { name: "Sign in" }).click();
    cy.location("pathname", { timeout: 20000 }).should("eq", "/workspace");
    cy.findByRole("heading", { name: "What do you want to translate?" }).should("be.visible");
  });

  it("wrong password vs unknown account → byte-identical error (anti-enumeration)", () => {
    // The property is INDISTINGUISHABILITY: capture both messages and compare them
    // to each other, so no copy is hard-coded and a reworded leak still fails.
    function failedSignInMessage(withEmail: string, withPassword: string) {
      cy.visit("/login");
      cy.hydrated("form");
      cy.findByLabelText("Email").type(withEmail);
      cy.findByLabelText("Password").type(withPassword, { log: false });
      cy.findByRole("button", { name: "Sign in" }).click();
      return cy
        .findByRole("alert")
        .should("be.visible")
        .invoke("text")
        .then((t) => t.trim());
    }

    failedSignInMessage(email, "definitely-wrong-password").then((existing) => {
      cy.location("pathname").should("eq", "/login");
      expect(existing, "error message should not be empty").to.not.eq("");
      failedSignInMessage(`no-such-user-${Date.now()}@example.invalid`, "definitely-wrong-password").then(
        (unknown) => {
          expect(unknown, "unknown-account and wrong-password errors must be identical").to.eq(existing);
        },
      );
    });
  });

  it("malformed email → inline error, focus moves to the field, no navigation", () => {
    cy.visit("/login");
    cy.hydrated("form");
    cy.findByLabelText("Email").type("not-an-email");
    cy.findByLabelText("Password").type("long-enough-password", { log: false });
    cy.findByRole("button", { name: "Sign in" }).click();
    cy.contains("#email-error", "Enter a valid email address.").should("be.visible");
    cy.findByLabelText("Email").should("have.attr", "aria-invalid", "true").and("have.focus");
    cy.location("pathname").should("eq", "/login");
  });

  it("show/hide password toggle → reveals the value and updates its label", () => {
    cy.visit("/login");
    cy.hydrated("form");
    cy.findByLabelText("Password").type("secret-password", { log: false });
    cy.findByRole("button", { name: "Show password" }).click();
    cy.findByLabelText("Password").should("have.attr", "type", "text");
    cy.findByRole("button", { name: "Hide password" }).click();
    cy.findByLabelText("Password").should("have.attr", "type", "password");
  });

  it("already signed in → /login bounces to the workspace", () => {
    cy.login();
    cy.visit("/login");
    cy.location("pathname", { timeout: 20000 }).should("eq", "/workspace");
  });

  it("safe ?next= is honoured for a signed-in visitor", () => {
    cy.login();
    cy.visit("/login?next=/billing");
    cy.location("pathname", { timeout: 20000 }).should("eq", "/billing");
  });

  it("open-redirect ?next=//evil.example is rejected → workspace", () => {
    cy.login();
    cy.visit("/login?next=//evil.example");
    cy.location("pathname", { timeout: 20000 }).should("eq", "/workspace");
  });
});
