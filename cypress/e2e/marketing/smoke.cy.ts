// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

describe("Marketing smoke", () => {
  it("landing page renders with the signed-out header CTA", () => {
    cy.visit("/");
    cy.findByRole("heading", { level: 1, name: "Describe what you need. We build the infrastructure." }).should(
      "be.visible",
    );
    cy.contains("a", "Log in").should("be.visible").and("have.attr", "href", "/login");
  });

  it("pricing page renders", () => {
    cy.visit("/pricing");
    cy.findByRole("heading", { level: 1, name: "Free for public good." }).should("be.visible");
  });

  it("the public verifier renders without signing in", () => {
    cy.visit("/verify");
    cy.findByRole("heading", { level: 1, name: "Verify an evidence bundle" }).should("be.visible");
    cy.get('input[aria-label="Choose an evidence bundle"]').should("exist");
  });

  it("an unknown page is the branded 404", () => {
    cy.request({ url: "/definitely-not-a-page", failOnStatusCode: false }).its("status").should("eq", 404);
    cy.visit("/definitely-not-a-page", { failOnStatusCode: false });
    cy.findByRole("heading", { level: 1, name: "We can’t find that page" }).should("be.visible");
  });
});
