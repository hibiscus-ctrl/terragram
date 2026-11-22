// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

// The core journey: create a workspace → describe it → the canvas fills → the
// turn is saved as a snapshot → review → evidence bundle downloaded and verified
// → a review link opened anonymously → revoked.
//
// NO MODEL SPEND: translation runs on the managed (paid) model only when the
// deployment sets WORKSPACE_ENGINE=managed AND the user's org is managed-entitled.
// The e2e user's org is on the free plan, so every turn here is the deterministic
// engine — and the verify step asserts that, so a run that did reach the model
// fails instead of silently billing.
//
// WRITES ROWS: the workspace (with its snapshots, receipt and share link) is
// renamed `e2e-journey-*` first thing and deleted by `cleanupWorkspaces` in
// after(), which also removes anything a crashed earlier run left.

describe("Workspace journey", () => {
  const name = `e2e-journey-${Date.now()}`;
  let workspaceId = "";
  let sharedPath = "";

  before(() => {
    cy.login();
    cy.task("cleanupWorkspaces");
  });

  after(() => {
    cy.task("cleanupWorkspaces");
  });

  it("creates a workspace from the mode picker and names it", () => {
    cy.login();
    cy.visit("/workspace");
    // A server-action form: it submits correctly even before hydration.
    cy.contains("button", "Chat to Terraform").click();
    cy.location("pathname", { timeout: 20000 }).should("eq", "/workspace/canvas");
    cy.location("search").should("match", /[?&]id=[0-9a-f-]{36}/);
    cy.location("search").then((search) => {
      workspaceId = new URLSearchParams(search).get("id") ?? "";
      expect(workspaceId, "persisted workspace id").to.match(/^[0-9a-f-]{36}$/);

      // Rename at once, so the cleanup task can find it whatever fails later.
      cy.visit("/workspace");
      cy.get(`a[href="/workspace/canvas?id=${workspaceId}"]`)
        .closest("li")
        .within(() => {
          cy.hydrated("button");
          cy.get('button[aria-label^="Rename "]').click();
        });
      // Editing swaps the row's link for the name field, so the row can no longer
      // be found through that link: Cypress re-runs the get → closest chain on
      // every command inside `within`. Only this row is editing, so its field and
      // Save button are unique on the page.
      cy.findByLabelText("Workspace name").clear().type(name);
      cy.findByRole("button", { name: "Save name" }).click();
      cy.contains("li", name).should("be.visible");
    });
  });

  it("describes an architecture and the canvas fills; the turn is saved as a snapshot", () => {
    cy.login();
    cy.visit(`/workspace/canvas?id=${workspaceId}`);
    cy.hydrated("#compose-input");
    cy.get("#compose-input").type("A web app on App Service with a PostgreSQL database and a Redis cache");
    cy.findByRole("button", { name: "Send" }).click();
    cy.contains(/[1-9]\d* nodes? · /, { timeout: 30000 }).should("be.visible");
    cy.get('[aria-label="Diagram canvas"]').contains(/postgres/i).should("exist");

    // Autosave: the turn lands as the newest snapshot.
    cy.clickUntil('[role="menu"]', () => cy.findByRole("button", { name: "History" }).click());
    cy.findByRole("menu").within(() => {
      cy.contains("Snapshot history").should("be.visible");
      cy.contains("Current", { timeout: 15000 }).should("be.visible");
    });
  });

  it("passes the review gate and downloads an evidence bundle that verifies", () => {
    cy.login();
    cy.visit(`/workspace/canvas?id=${workspaceId}`);
    cy.contains(/[1-9]\d* nodes? · /, { timeout: 30000 }).should("be.visible");
    cy.hydrated("#compose-input");
    cy.findByRole("button", { name: "Generate code" }).should("be.enabled").click();
    cy.findByRole("heading", { name: "Review gate" }).should("be.visible");
    cy.findByRole("button", { name: /^(Confirm & generate|Generate anyway)$/ }).click();
    cy.contains(/resources? ready/, { timeout: 30000 }).should("be.visible");
    cy.contains("Recorded in this workspace's audit trail.").should("be.visible");

    cy.findByRole("button", { name: "Download evidence bundle" }).click();
    const bundle = `${Cypress.config("downloadsFolder")}/terragram-evidence.zip`;
    cy.readFile(bundle, "binary", { timeout: 15000 }).should("have.length.greaterThan", 100);

    cy.visit("/verify");
    cy.findByRole("heading", { name: "Verify an evidence bundle" }).should("be.visible");
    cy.hydrated('input[aria-label="Choose an evidence bundle"]');
    cy.get('input[aria-label="Choose an evidence bundle"]').selectFile(bundle, { force: true });
    cy.contains(/This bundle (is intact|did not fully verify)/, { timeout: 15000 }).should("be.visible");
    // The hash always verifies offline; the signature only where a key is configured.
    cy.contains("Content hash · Verified").should("be.visible");
    // The guard on model spend: this turn must have come from the local engine.
    cy.contains("Deterministic · local").should("be.visible");
  });

  it("mints a review link", () => {
    cy.login();
    cy.visit(`/workspace/canvas?id=${workspaceId}`);
    cy.hydrated("#compose-input");
    cy.clickUntil('[role="menu"]', () => cy.contains("button", "Share").click());
    cy.findByRole("button", { name: "Create review link" }).click();
    cy.contains("p", "/shared/", { timeout: 15000 })
      .invoke("text")
      .then((text) => {
        sharedPath = new URL(text.trim()).pathname;
        expect(sharedPath).to.match(/^\/shared\/[\w-]+$/);
      });
  });

  it("opens the review link signed out, read-only", () => {
    cy.clearAllCookies();
    cy.visit(sharedPath);
    cy.contains("Read-only review link").should("be.visible");
    cy.contains(name).should("be.visible");
    cy.findByRole("heading", { name: "Diagram" }).should("be.visible");
    // A reviewer cannot act: none of the owner's controls are on the page.
    cy.findByRole("button", { name: "Generate code" }).should("not.exist");
    cy.contains("button", "Share").should("not.exist");
  });

  it("revokes the link, after which it is a plain 404", () => {
    cy.login();
    cy.visit(`/workspace/canvas?id=${workspaceId}`);
    cy.hydrated("#compose-input");
    cy.clickUntil('[role="menu"]', () => cy.contains("button", "Share").click());
    cy.contains("Active links · 1", { timeout: 15000 }).should("be.visible");
    cy.findByRole("button", { name: "Revoke" }).click();
    cy.contains("Link revoked").should("be.visible");

    cy.clearAllCookies();
    cy.request({ url: sharedPath, failOnStatusCode: false }).its("status").should("eq", 404);
  });
});
