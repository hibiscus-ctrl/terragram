// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// A seeded, deterministic workspace (scripts/e2e-seed-workspace.mjs): it is
// listed, opens on its latest snapshot, and its history shows every snapshot.
// Read-mostly; the seeder resets the history on every run and the cleanup task
// removes the workspace afterwards.

describe("Seeded workspace", () => {
  let fixture: { id: string; name: string; snapshots: number };

  before(() => {
    cy.login();
    cy.task("seedWorkspace").then((seeded) => {
      fixture = seeded;
    });
  });

  after(() => {
    cy.task("cleanupWorkspaces");
  });

  it("is listed on the workspace home and opens on its latest snapshot", () => {
    cy.login();
    cy.visit("/workspace");
    cy.contains("Your workspaces").should("be.visible");
    cy.get(`a[href="/workspace/canvas?id=${fixture.id}"]`).should("contain.text", fixture.name).click();
    cy.location("search", { timeout: 20000 }).should("include", fixture.id);
    cy.contains("3 nodes · auto-routed", { timeout: 20000 }).should("be.visible");
    cy.get('[aria-label="Diagram canvas"]').within(() => {
      for (const label of ["e2e web app", "e2e database", "e2e cache"]) cy.contains(label).should("exist");
    });
  });

  it("shows the full snapshot history, newest first", () => {
    cy.login();
    cy.visit(`/workspace/canvas?id=${fixture.id}`);
    cy.hydrated("#compose-input");
    cy.clickUntil('[role="menu"]', () => cy.findByRole("button", { name: "History" }).click());
    cy.findByRole("menu").within(() => {
      cy.findAllByRole("menuitem", { timeout: 15000 }).should("have.length.at.least", fixture.snapshots);
      cy.findAllByRole("menuitem").first().should("contain.text", "Current").and("contain.text", "3 nodes");
      cy.findAllByRole("menuitem").last().should("contain.text", "1 nodes");
    });
  });
});
