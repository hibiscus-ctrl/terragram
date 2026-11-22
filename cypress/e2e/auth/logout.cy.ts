// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

describe("Sign out", () => {
  // A dedicated user so signing out here cannot invalidate the shared cy.session
  // cache the other specs restore (Supabase revokes the server-side session on
  // signOut, which would make restored cookies dead on arrival).
  const email = "test-e2e-logout@terragram.dev";
  const password = Cypress.expose("E2E_USER_PASSWORD") as string;

  it("account menu → Sign out → back on /login and locked out of the workspace", () => {
    cy.login(email, password);
    // The site header's account menu appears once the client auth state hydrates.
    cy.visit("/");
    cy.clickUntil('[role="menu"]', () => cy.get('[aria-label^="Account menu"]', { timeout: 15000 }).click());
    cy.findByRole("menuitem", { name: "Sign out" }).click();
    cy.location("pathname", { timeout: 20000 }).should("eq", "/login");
    // The session is really gone: a protected page bounces straight back.
    cy.visit("/workspace");
    cy.location("pathname").should("eq", "/login");
  });
});
